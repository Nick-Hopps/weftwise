import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checkpoint-handle-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('loadCheckpoint', () => {
  it('空 job：hasAny=false，各 getter 返回 undefined', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const ckpt = loadCheckpoint('j1');
    expect(ckpt.hasAny()).toBe(false);
    expect(ckpt.getPlan()).toBeUndefined();
    expect(ckpt.getChunkSummary('s1:c0')).toBeUndefined();
    expect(ckpt.getWriterPage('a')).toBeUndefined();
  });

  it('put 后内存即时可读，且重新 loadCheckpoint 能从 DB 读回（落盘）', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const ckpt = loadCheckpoint('j1');
    ckpt.putChunkSummary('s1:c0', '摘要零');
    ckpt.putPlan({ plan: { pages: [{ slug: 'a' }, { slug: 'b' }] } });
    ckpt.putWriterPage('a', { action: 'create', path: 'wiki/general/a.md', content: '# A' });

    expect(ckpt.getChunkSummary('s1:c0')).toBe('摘要零');
    expect(ckpt.getWriterPage('a')).toEqual({ action: 'create', path: 'wiki/general/a.md', content: '# A' });
    expect(ckpt.hasAny()).toBe(true);

    const reloaded = loadCheckpoint('j1');
    expect(reloaded.getChunkSummary('s1:c0')).toBe('摘要零');
    expect((reloaded.getPlan() as { plan: { pages: unknown[] } }).plan.pages).toHaveLength(2);
    expect(reloaded.getWriterPage('a')).toEqual({ action: 'create', path: 'wiki/general/a.md', content: '# A' });
  });

  it('progress 汇总计数并从 plan 推出 totalPages', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const ckpt = loadCheckpoint('j1');
    ckpt.putPlan({ plan: { pages: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }] } });
    ckpt.putChunkSummary('s1:c0', 'x');
    ckpt.putWriterPage('a', { action: 'create', path: 'wiki/general/a.md', content: '' });
    expect(ckpt.progress()).toEqual({ plan: true, chunkSummaries: 1, writerPages: 1, totalPages: 3 });
  });

  it('clear 后 hasAny=false 且重新加载为空', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const ckpt = loadCheckpoint('j1');
    ckpt.putPlan({ plan: { pages: [] } });
    ckpt.clear();
    expect(ckpt.hasAny()).toBe(false);
    expect(loadCheckpoint('j1').hasAny()).toBe(false);
  });
});
