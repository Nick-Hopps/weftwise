import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'indexer-wakeup-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('collectNeighborSlugs', () => {
  it('聚合 A 的 backlink 源与出链目标，去重且排除自身', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const pagesRepo = await import('@/server/db/repos/pages-repo');
    const { collectNeighborSlugs } = await import('@/server/wiki/indexer');

    const subjectId = subjectsRepo.create({ slug: `s-wakeup`, name: 'S' }).id;

    // 直接写 wiki_links：B → A（A 的 backlink），A → C（A 的出链）
    pagesRepo.setLinksForPage(subjectId, 'b', [
      { targetSubjectId: subjectId, targetSlug: 'a', context: '[[A]]' },
    ]);
    pagesRepo.setLinksForPage(subjectId, 'a', [
      { targetSubjectId: subjectId, targetSlug: 'c', context: '[[C]]' },
    ]);

    const n = collectNeighborSlugs(subjectId, 'a')
      .map((x) => x.slug)
      .sort();
    expect(n).toEqual(['b', 'c']);
    expect(n).not.toContain('a');
  });

  it('自身既是 backlink 源又是出链目标时不重复', async () => {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const pagesRepo = await import('@/server/db/repos/pages-repo');
    const { collectNeighborSlugs } = await import('@/server/wiki/indexer');

    const subjectId = subjectsRepo.create({ slug: `s-dedup`, name: 'S' }).id;

    // B → A，A → B（双向链接，B 不应出现两次）
    pagesRepo.setLinksForPage(subjectId, 'b', [
      { targetSubjectId: subjectId, targetSlug: 'a', context: '[[A]]' },
    ]);
    pagesRepo.setLinksForPage(subjectId, 'a', [
      { targetSubjectId: subjectId, targetSlug: 'b', context: '[[B]]' },
    ]);

    const n = collectNeighborSlugs(subjectId, 'a')
      .map((x) => x.slug)
      .sort();
    expect(n).toEqual(['b']); // 去重，B 只出现一次
  });
});
