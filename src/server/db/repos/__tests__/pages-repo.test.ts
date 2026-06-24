import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pages-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = '2026-01-01T00:00:00Z';

async function setup() {
  const { getRawDb } = await import('../../client');
  const db = getRawDb();

  const insSub = db.prepare(
    `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
  );
  insSub.run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
  insSub.run('s2', 'sub-b', 'Sub B', '', NOW, NOW);

  const insPage = db.prepare(
    `INSERT INTO pages (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  insPage.run('s1', 'target', 'Target', 's1/target.md', '', 'h', '[]', NOW, NOW);
  insPage.run('s1', 'page-a', 'Page A', 's1/page-a.md', '', 'h', '[]', NOW, NOW);
  insPage.run('s1', 'page-b', 'Page B', 's1/page-b.md', '', 'h', '[]', NOW, NOW);
  insPage.run('s1', 'page-meta', 'Meta', 's1/page-meta.md', '', 'h', '["meta"]', NOW, NOW);
  insPage.run('s2', 'page-c', 'Page C', 's2/page-c.md', '', 'h', '[]', NOW, NOW);

  const insLink = db.prepare(
    `INSERT INTO wiki_links (subject_id, source_slug, target_subject_id, target_slug, context)
     VALUES (?,?,?,?,?)`
  );
  // 插入顺序即 rowid（首现）顺序：page-b 先于 page-a
  insLink.run('s1', 'page-b', 's1', 'target', ''); // 1
  insLink.run('s1', 'page-a', 's1', 'target', ''); // 2
  insLink.run('s1', 'page-a', 's1', 'target', ''); // 3 重复 → 去重
  insLink.run('s1', 'page-meta', 's1', 'target', ''); // 4 meta 源 → 排除
  insLink.run('s2', 'page-c', 's1', 'target', ''); // 5 跨 subject
  insLink.run('s1', 'ghost', 's1', 'target', ''); // 6 悬空（无 page 行）→ 排除

  return import('../pages-repo');
}

describe('pages-repo.getBacklinks', () => {
  it('返回指向目标页的源页：去重、排除 meta 源与悬空链接、含跨 subject，按首现顺序', async () => {
    const repo = await setup();
    const result = repo.getBacklinks('s1', 'target');
    expect(result.map((p) => `${p.subjectId}:${p.slug}`)).toEqual([
      's1:page-b',
      's1:page-a',
      's2:page-c',
    ]);
  });

  it('无反向链接 → 空数组', async () => {
    const repo = await setup();
    expect(repo.getBacklinks('s1', 'page-a')).toEqual([]);
  });
});
