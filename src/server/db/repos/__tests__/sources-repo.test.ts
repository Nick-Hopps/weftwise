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

describe('sources-repo.listPageSourceIntegrityRows', () => {
  it('返回指定页面关联的 page/source 存在性与 source subject', async () => {
    const repo = await setup();
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    const insertPage = db.prepare(
      `INSERT INTO pages
       (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    insertPage.run('s1', 'page-a', 'Page A', 'wiki/sub-a/page-a.md', '', 'p1', '[]', NOW, NOW);
    insertPage.run('s1', 'cross-source-page', 'Cross', 'wiki/sub-a/cross-source-page.md', '', 'p2', '[]', NOW, NOW);
    const insertLink = db.prepare(
      `INSERT INTO page_sources (subject_id, page_slug, source_id) VALUES (?,?,?)`,
    );
    insertLink.run('s1', 'deleted-page', 'src1');
    insertLink.run('s1', 'cross-source-page', 'src3');

    expect(
      repo.listPageSourceIntegrityRows('s1', [
        'page-a',
        'deleted-page',
        'cross-source-page',
      ]),
    ).toEqual(
      expect.arrayContaining([
        {
          subjectId: 's1',
          pageSlug: 'page-a',
          sourceId: 'src1',
          pageExists: true,
          sourceSubjectId: 's1',
        },
        {
          subjectId: 's1',
          pageSlug: 'page-a',
          sourceId: 'ghost-src',
          pageExists: true,
          sourceSubjectId: null,
        },
        {
          subjectId: 's1',
          pageSlug: 'deleted-page',
          sourceId: 'src1',
          pageExists: false,
          sourceSubjectId: 's1',
        },
        {
          subjectId: 's1',
          pageSlug: 'cross-source-page',
          sourceId: 'src3',
          pageExists: true,
          sourceSubjectId: 's2',
        },
      ]),
    );
  });

  it('空 slug 列表直接返回空数组', async () => {
    const repo = await setup();
    expect(repo.listPageSourceIntegrityRows('s1', [])).toEqual([]);
  });
});

describe('sources-repo.listUnreferencedSources / deleteSource', () => {
  it('只返回本 subject 零 page_sources 关联的 source', async () => {
    const repo = await setup();
    const { getRawDb } = await import('../../client');
    getRawDb()
      .prepare(`INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json) VALUES (?,?,?,?,?,?)`)
      .run('src-orphan', 's1', 'orphan.md', 'h9', NOW, '{}');
    const ids = repo.listUnreferencedSources('s1').map((s) => s.id);
    expect(ids).toEqual(['src-orphan']); // src1/src2 有关联，src3 属 s2
  });

  it('deleteSource 删除指定行且不影响其他行', async () => {
    const repo = await setup();
    repo.deleteSource('src1');
    expect(repo.getSource('src1')).toBeNull();
    expect(repo.getSource('src2')).not.toBeNull();
  });

  it('全部已关联时返回空数组', async () => {
    const repo = await setup();
    expect(repo.listUnreferencedSources('s1')).toEqual([]);
  });

  it('其他 subject 的未引用 source 不泄漏进本 subject 查询', async () => {
    const repo = await setup();
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    // s2 加一个零关联 source：s1 查询不得包含它，s2 查询恰好返回它
    db.prepare(
      `INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json)
       VALUES (?,?,?,?,?,?)`
    ).run('src-orphan-2', 's2', 'other.md', 'h10', NOW, '{}');
    expect(repo.listUnreferencedSources('s1')).toEqual([]);
    expect(repo.listUnreferencedSources('s2').map((s) => s.id)).toEqual(['src-orphan-2']);
  });
});

describe('sources-repo source identity', () => {
  it('按 subject/hash/filename 精确查询，filename 不同不误命中', async () => {
    const repo = await setup();
    expect(repo.getSourceByIdentity('s1', 'h1', 'a.md')?.id).toBe('src1');
    expect(repo.getSourceByIdentity('s1', 'h1', 'renamed.md')).toBeNull();
    expect(repo.getSourceByIdentity('s2', 'h1', 'a.md')).toBeNull();
  });

  it('insertSourceOrGetWinner 在组合冲突时返回 canonical winner', async () => {
    const repo = await setup();
    const result = repo.insertSourceOrGetWinner({
      id: 'loser',
      subjectId: 's1',
      filename: 'a.md',
      contentHash: 'h1',
      parsedAt: null,
      metadataJson: '{}',
    });
    expect(result).toMatchObject({ inserted: false, source: { id: 'src1' } });
  });

  it('持久化 loser sidecar 补偿记录供启动维护重试', async () => {
    const repo = await setup();
    const { getRawDb } = await import('../../client');
    repo.recordSourceSidecarCleanup({
      loserId: 'loser-sidecar',
      winnerId: 'src1',
      subjectSlug: 'sub-a',
      filename: 'a.md',
    });
    expect(getRawDb().prepare(`
      SELECT loser_id, winner_id, subject_slug, filename
      FROM source_dedup_cleanup
      WHERE loser_id = 'loser-sidecar'
    `).get()).toEqual({
      loser_id: 'loser-sidecar',
      winner_id: 'src1',
      subject_slug: 'sub-a',
      filename: 'a.md',
    });
  });
});
