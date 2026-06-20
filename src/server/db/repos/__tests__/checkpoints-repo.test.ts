import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checkpoints-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('checkpoints-repo', () => {
  it('getCheckpoints 在无记录时返回空数组', async () => {
    const repo = await import('../checkpoints-repo');
    expect(repo.getCheckpoints('job-x')).toEqual([]);
  });

  it('putCheckpoint 写入后 getCheckpoints 能读回（data_json 反序列化）', async () => {
    const repo = await import('../checkpoints-repo');
    repo.putCheckpoint('j1', 'chunk-summary', 's1:c0', { summary: '摘要零' });
    repo.putCheckpoint('j1', 'writer-page', 'page-a', { action: 'create', path: 'wiki/general/page-a.md', content: '# A' });
    const rows = repo.getCheckpoints('j1');
    expect(rows).toHaveLength(2);
    const summary = rows.find((r) => r.kind === 'chunk-summary');
    expect(summary).toEqual({ kind: 'chunk-summary', key: 's1:c0', data: { summary: '摘要零' } });
  });

  it('putCheckpoint 同 (job,kind,key) 幂等覆盖（upsert）', async () => {
    const repo = await import('../checkpoints-repo');
    repo.putCheckpoint('j1', 'plan', '', { plan: { pages: [{ slug: 'a' }] } });
    repo.putCheckpoint('j1', 'plan', '', { plan: { pages: [{ slug: 'a' }, { slug: 'b' }] } });
    const rows = repo.getCheckpoints('j1').filter((r) => r.kind === 'plan');
    expect(rows).toHaveLength(1);
    expect((rows[0].data as { plan: { pages: unknown[] } }).plan.pages).toHaveLength(2);
  });

  it('deleteCheckpoints 清空该 job 的全部检查点（不影响其他 job）', async () => {
    const repo = await import('../checkpoints-repo');
    repo.putCheckpoint('j1', 'plan', '', { plan: { pages: [] } });
    repo.putCheckpoint('j2', 'plan', '', { plan: { pages: [] } });
    repo.deleteCheckpoints('j1');
    expect(repo.getCheckpoints('j1')).toEqual([]);
    expect(repo.getCheckpoints('j2')).toHaveLength(1);
  });

  it('getProgress 无检查点返回 null；有则汇总计数并从 plan 推出 totalPages', async () => {
    const repo = await import('../checkpoints-repo');
    expect(repo.getProgress('j1')).toBeNull();
    repo.putCheckpoint('j1', 'plan', '', { plan: { pages: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }] } });
    repo.putCheckpoint('j1', 'chunk-summary', 's1:c0', { summary: 'x' });
    repo.putCheckpoint('j1', 'chunk-summary', 's1:c1', { summary: 'y' });
    repo.putCheckpoint('j1', 'writer-page', 'a', { action: 'create', path: 'wiki/general/a.md', content: '' });
    expect(repo.getProgress('j1')).toEqual({
      plan: true,
      chunkSummaries: 2,
      writerPages: 1,
      totalPages: 3,
    });
  });
});
