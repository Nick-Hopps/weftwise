import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WikiPage } from '@/lib/contracts';

let dir: string;
let prevDb: string | undefined;

const NOW = '2026-07-14T00:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pages-invariants-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

function page(subjectId: string, subjectSlug: string, slug: string, title: string): WikiPage {
  return {
    subjectId,
    slug,
    title,
    path: `wiki/${subjectSlug}/${slug}.md`,
    summary: `${title} summary`,
    contentHash: `${subjectId}-${slug}-hash`,
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function setup() {
  const { getRawDb } = await import('../../client');
  const db = getRawDb();
  const insertSubject = db.prepare(
    `INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?)`,
  );
  insertSubject.run('s1', 'subject-a', 'Subject A', NOW, NOW);
  insertSubject.run('s2', 'subject-b', 'Subject B', NOW, NOW);
  return { db, repo: await import('../pages-repo') };
}

describe('pages-repo 复合身份约束', () => {
  it('跨 Subject 同 slug 合法，同 Subject 重复与全局 path 重复非法', async () => {
    const { db, repo } = await setup();
    const first = page('s1', 'subject-a', 'shared', 'Shared A');
    const second = page('s2', 'subject-b', 'shared', 'Shared B');
    repo.upsertPage(first);
    repo.upsertPage(second);

    expect(repo.getPageBySlug('s1', 'shared')).toMatchObject({ title: 'Shared A' });
    expect(repo.getPageBySlug('s2', 'shared')).toMatchObject({ title: 'Shared B' });

    const insert = db.prepare(`
      INSERT INTO pages (
        subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', ?, '[]', ?, ?)
    `);
    expect(() => insert.run(
      's1', 'shared', 'Duplicate', 'wiki/subject-a/duplicate.md', 'duplicate-hash', NOW, NOW,
    )).toThrow(/UNIQUE constraint failed: pages\.subject_id, pages\.slug/);
    expect(() => insert.run(
      's2', 'other', 'Path collision', first.path, 'path-hash', NOW, NOW,
    )).toThrow(/UNIQUE constraint failed: pages\.path/);
  });

  it('upsert 与 delete 只影响精确的 subject+slug 身份', async () => {
    const { db, repo } = await setup();
    repo.upsertPage(page('s1', 'subject-a', 'shared', 'Shared A'));
    repo.upsertPage(page('s2', 'subject-b', 'shared', 'Shared B'));
    repo.upsertPage({
      ...page('s1', 'subject-a', 'shared', 'Shared A Updated'),
      summary: 'updated only in subject A',
      updatedAt: '2026-07-14T01:00:00.000Z',
    });

    expect(repo.getPageBySlug('s1', 'shared')).toMatchObject({
      title: 'Shared A Updated',
      summary: 'updated only in subject A',
    });
    expect(repo.getPageBySlug('s2', 'shared')).toMatchObject({
      title: 'Shared B',
      summary: 'Shared B summary',
    });

    repo.setLinksForPage('s1', 'shared', [
      { targetSubjectId: 's1', targetSlug: 'target-a', context: 'a' },
    ]);
    repo.setLinksForPage('s2', 'shared', [
      { targetSubjectId: 's2', targetSlug: 'target-b', context: 'b' },
    ]);
    repo.deletePage('s1', 'shared');

    expect(repo.getPageBySlug('s1', 'shared')).toBeNull();
    expect(repo.getPageBySlug('s2', 'shared')).toMatchObject({ title: 'Shared B' });
    expect(db.prepare(
      `SELECT subject_id, source_slug FROM wiki_links ORDER BY subject_id`,
    ).all()).toEqual([{ subject_id: 's2', source_slug: 'shared' }]);
  });
});

describe('pages-repo 手动 FTS 一致性', () => {
  it('update 替换旧索引且按 Subject 隔离，不产生重复行', async () => {
    const { db, repo } = await setup();
    repo.upsertPage(page('s1', 'subject-a', 'shared', 'Shared A'));
    repo.upsertPage(page('s2', 'subject-b', 'shared', 'Shared B'));
    repo.updateFtsEntry('s1', 'shared', 'Shared A', 'old summary', 'legacyterm');
    repo.updateFtsEntry('s2', 'shared', 'Shared B', 'other summary', 'otherterm');

    expect(repo.searchPages('s1', 'legacyterm').map((result) => result.page.title))
      .toEqual(['Shared A']);
    expect(repo.searchPages('s2', 'otherterm').map((result) => result.page.title))
      .toEqual(['Shared B']);

    repo.updateFtsEntry('s1', 'shared', 'Shared A Updated', 'fresh summary', 'freshterm');

    expect(repo.searchPages('s1', 'legacyterm')).toEqual([]);
    expect(repo.searchPages('s1', 'freshterm')).toEqual([
      expect.objectContaining({ page: expect.objectContaining({ title: 'Shared A' }) }),
    ]);
    expect(repo.searchPages('s2', 'otherterm').map((result) => result.page.title))
      .toEqual(['Shared B']);
    expect(db.prepare(
      `SELECT subject_id, slug, COUNT(*) AS count
       FROM pages_fts WHERE slug = 'shared'
       GROUP BY subject_id, slug ORDER BY subject_id`,
    ).all()).toEqual([
      { subject_id: 's1', slug: 'shared', count: 1 },
      { subject_id: 's2', slug: 'shared', count: 1 },
    ]);
  });

  it('deleteFtsEntry 与 deletePage 只清理目标 Subject 的 FTS 行', async () => {
    const { db, repo } = await setup();
    repo.upsertPage(page('s1', 'subject-a', 'shared', 'Shared A'));
    repo.upsertPage(page('s2', 'subject-b', 'shared', 'Shared B'));
    repo.updateFtsEntry('s1', 'shared', 'Shared A', '', 'subjectaterm');
    repo.updateFtsEntry('s2', 'shared', 'Shared B', '', 'subjectbterm');

    repo.deleteFtsEntry('s1', 'shared');
    expect(repo.searchPages('s1', 'subjectaterm')).toEqual([]);
    expect(repo.searchPages('s2', 'subjectbterm')).toHaveLength(1);

    repo.updateFtsEntry('s1', 'shared', 'Shared A', '', 'subjectaterm');
    repo.deletePage('s1', 'shared');
    expect(db.prepare(
      `SELECT subject_id, slug FROM pages_fts ORDER BY subject_id`,
    ).all()).toEqual([{ subject_id: 's2', slug: 'shared' }]);
    expect(repo.searchPages('s2', 'subjectbterm')).toHaveLength(1);
  });
});
