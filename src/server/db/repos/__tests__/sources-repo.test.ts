import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sources-repo-'));
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

  const insSrc = db.prepare(
    `INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json)
     VALUES (?,?,?,?,?,?)`
  );
  insSrc.run('src1', 's1', 'a.md', 'h1', NOW, '{}');
  insSrc.run('src2', 's1', 'b.md', 'h2', NOW, '{}');
  insSrc.run('src3', 's2', 'c.md', 'h3', NOW, '{}');

  const insLink = db.prepare(
    `INSERT INTO page_sources (subject_id, page_slug, source_id) VALUES (?,?,?)`
  );
  insLink.run('s1', 'page-a', 'src1');
  insLink.run('s1', 'page-a', 'src2');
  insLink.run('s1', 'page-a', 'ghost-src'); // 无 sources 行 → 排除
  insLink.run('s2', 'page-a', 'src3'); // 不同 subject → 不出现在 s1 查询

  return import('../sources-repo');
}

describe('sources-repo.getSourcesForPage', () => {
  it('取本页本 subject 的源，排除悬空 source 链接', async () => {
    const repo = await setup();
    const ids = repo
      .getSourcesForPage('s1', 'page-a')
      .map((s) => s.id)
      .sort();
    expect(ids).toEqual(['src1', 'src2']);
  });

  it('subject 隔离：不串其它 subject 的同名 page', async () => {
    const repo = await setup();
    expect(repo.getSourcesForPage('s2', 'page-a').map((s) => s.id)).toEqual(['src3']);
  });

  it('无源 → 空数组', async () => {
    const repo = await setup();
    expect(repo.getSourcesForPage('s1', 'nope')).toEqual([]);
  });
});
