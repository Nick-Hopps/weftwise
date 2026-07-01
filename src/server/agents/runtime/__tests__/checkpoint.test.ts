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
    expect(ckpt.progress()).toEqual({ plan: false, chunkSummaries: 0, writerPages: 0, totalPages: null });
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

describe('IngestCheckpoint — cited sources (⑨ 续传补源)', () => {
  it('putCitedSources 落盘 + 重新 loadCheckpoint 读回；clear 后清空', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const jobId = `ckpt-cited-${Math.random().toString(36).slice(2)}`;
    const ck = loadCheckpoint(jobId);
    expect(ck.getCitedSources()).toEqual([]);

    const list = [
      { url: 'https://a.com/x', title: 'A', citedBy: ['p1', 'p2'], fallbackContent: 'snip-a' },
      { url: 'https://b.com/y', title: 'B', citedBy: ['p3'], fallbackContent: 'snip-b' },
    ];
    ck.putCitedSources(list);
    expect(ck.getCitedSources()).toEqual(list);

    const reloaded = loadCheckpoint(jobId);
    expect(reloaded.getCitedSources()).toEqual(list);
    expect(reloaded.hasAny()).toBe(true);

    reloaded.clear();
    expect(reloaded.getCitedSources()).toEqual([]);
    expect(loadCheckpoint(jobId).getCitedSources()).toEqual([]);
  });
});

describe('IngestCheckpoint — enricher/verifier page', () => {
  it('enricher/verifier page 双写并按 slug 读回', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const jobId = `ckpt-stage-${Math.random().toString(36).slice(2)}`;
    const ck = loadCheckpoint(jobId);
    const e = { action: 'create' as const, path: 'wiki/general/a.md', content: 'enriched' };
    const v = { action: 'create' as const, path: 'wiki/general/a.md', content: 'verified' };
    ck.putEnricherPage('a', e);
    ck.putVerifierPage('a', v);

    const reloaded = loadCheckpoint(jobId);
    expect(reloaded.getEnricherPage('a')).toEqual(e);
    expect(reloaded.getVerifierPage('a')).toEqual(v);
    expect(reloaded.getWriterPage('a')).toBeUndefined();
    reloaded.clear();
  });
});

describe('IngestCheckpoint — supplement page', () => {
  it('supplement page 双写并按 slug 读回，clear 后清空', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const jobId = `ckpt-supplement-${Math.random().toString(36).slice(2)}`;
    const ck = loadCheckpoint(jobId);
    expect(ck.getSupplementPage('a')).toBeUndefined();
    const s = { action: 'update' as const, path: 'wiki/general/a.md', content: 'supplemented' };
    ck.putSupplementPage('a', s);

    const reloaded = loadCheckpoint(jobId);
    expect(reloaded.getSupplementPage('a')).toEqual(s);
    expect(reloaded.hasAny()).toBe(true);
    reloaded.clear();
    expect(loadCheckpoint(jobId).getSupplementPage('a')).toBeUndefined();
  });
});
