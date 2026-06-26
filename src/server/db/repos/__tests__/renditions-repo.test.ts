import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'renditions-repo-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => {
  process.env.DATABASE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  subjectId: 's1',
  slug: 'a',
  canonicalHash: 'h1',
  profileVersion: 1,
  renderedMd: '重塑版',
  model: 'm',
};

describe('renditions-repo', () => {
  it('命中：hash+version 都匹配才返回', async () => {
    const repo = await import('../renditions-repo');
    repo.upsertRendition(base);
    expect(repo.getRendition('s1', 'a', 'h1', 1)).toBe('重塑版');
    expect(repo.getRendition('s1', 'a', 'h2', 1)).toBeNull(); // canonical 变了
    expect(repo.getRendition('s1', 'a', 'h1', 2)).toBeNull(); // 画像变了
  });

  it('upsert 覆盖（一页一行）', async () => {
    const repo = await import('../renditions-repo');
    repo.upsertRendition(base);
    repo.upsertRendition({ ...base, canonicalHash: 'h9', profileVersion: 5, renderedMd: '新版' });
    expect(repo.getRendition('s1', 'a', 'h1', 1)).toBeNull();
    expect(repo.getRendition('s1', 'a', 'h9', 5)).toBe('新版');
  });

  it('deleteBySubject 清空该 subject 缓存', async () => {
    const repo = await import('../renditions-repo');
    repo.upsertRendition(base);
    repo.upsertRendition({ ...base, subjectId: 's2' });
    repo.deleteBySubject('s1');
    expect(repo.getRendition('s1', 'a', 'h1', 1)).toBeNull();
    expect(repo.getRendition('s2', 'a', 'h1', 1)).toBe('重塑版');
  });
});
