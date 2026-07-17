import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let vaultDir: string;
let dbDir: string;
let previousVault: string | undefined;
let previousDb: string | undefined;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'wiki-move-vault-'));
  dbDir = mkdtempSync(join(tmpdir(), 'wiki-move-db-'));
  previousVault = process.env.VAULT_PATH;
  previousDb = process.env.DATABASE_PATH;
  process.env.VAULT_PATH = vaultDir;
  process.env.DATABASE_PATH = join(dbDir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.VAULT_PATH = previousVault;
  process.env.DATABASE_PATH = previousDb;
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

function page(title: string, body: string): string {
  return [
    '---',
    `title: ${title}`,
    "created: '2026-01-01T00:00:00.000Z'",
    "updated: '2026-01-01T00:00:00.000Z'",
    'tags: []',
    'sources: []',
    '---',
    '',
    body,
  ].join('\n');
}

describe('wiki.move Saga integration', () => {
  it('一次提交迁移文件、同/跨 Subject 链接、alias、来源 sidecar 与全部 slug cache', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const sourcesRepo = await import('../../db/repos/sources-repo');
    const pagesRepo = await import('../../db/repos/pages-repo');
    const renditionsRepo = await import('../../db/repos/renditions-repo');
    const { getRawDb } = await import('../../db/client');
    const { ensureVaultRepo, commitVaultChanges } = await import('../../git/git-service');
    const { writeVaultFiles } = await import('../wiki-store');
    const { rebuildPageIndex } = await import('../indexer');
    const { planPageMove, applyPlannedPageOperation } = await import('../page-operation-plan');

    await ensureVaultRepo();
    const suffix = randomUUID().slice(0, 8);
    const subject = subjectsRepo.create({ slug: `move-${suffix}`, name: 'Move' });
    const other = subjectsRepo.create({ slug: `other-${suffix}`, name: 'Other' });
    const oldPath = `wiki/${subject.slug}/old-page.md`;
    const notePath = `wiki/${subject.slug}/notes.md`;
    const foreignPath = `wiki/${other.slug}/foreign.md`;
    const sidecarPath = `.llm-wiki/sources/${subject.slug}/source-1.json`;
    writeVaultFiles([
      { path: oldPath, content: page('Old Title', 'Self [[old-page]].') },
      { path: notePath, content: page('Notes', 'See [[Old Title#part|old]].') },
      { path: foreignPath, content: page('Foreign', `See [[${subject.slug}:old-page]].`) },
      {
        path: sidecarPath,
        content: JSON.stringify({
          id: 'source-1', subjectId: subject.id, subjectSlug: subject.slug,
          filename: 'source.txt', contentHash: 'hash-1', linkedPages: ['old-page'],
        }, null, 2),
      },
    ]);
    await commitVaultChanges('seed move integration', [
      oldPath, notePath, foreignPath, sidecarPath,
    ]);
    rebuildPageIndex();

    sourcesRepo.upsertSource({
      id: 'source-1', subjectId: subject.id, filename: 'source.txt',
      contentHash: 'hash-1', parsedAt: null, metadataJson: '{}',
    });
    sourcesRepo.linkPageSource(subject.id, 'old-page', 'source-1');
    const db = getRawDb();
    db.prepare(`
      INSERT INTO page_embeddings VALUES (?, 'old-page', 'm', 'h', 1, ?, 'now')
    `).run(subject.id, Buffer.from([1]));
    db.prepare(`
      INSERT INTO page_maturity VALUES (?, 'old-page', 2, 'then', 7, 'next', 'active', 3, 'now')
    `).run(subject.id);
    db.prepare(`
      INSERT INTO page_renditions VALUES (?, 'old-page', 'h', 2, 'rendered', 'm', 'now')
    `).run(subject.id);
    db.prepare(`
      INSERT INTO page_rendition_assets VALUES ('old-asset', ?, 'old-page', 'image/png', 'YQ==', 'now')
    `).run(subject.id);

    const plan = await planPageMove('job-move', subject, {
      slug: 'old-page', newSlug: 'new-page', effectiveAt: '2026-07-14T00:00:00.000Z',
    });
    const result = await applyPlannedPageOperation(plan);

    expect(result).toMatchObject({
      movedFromSlug: 'old-page', movedToSlug: 'new-page',
      referencesUpdated: 2, sourceLinksMigrated: 1,
    });
    expect(existsSync(join(vaultDir, oldPath))).toBe(false);
    expect(existsSync(join(vaultDir, `wiki/${subject.slug}/new-page.md`))).toBe(true);
    expect(readFileSync(join(vaultDir, notePath), 'utf-8')).toContain('[[new-page#part|old]]');
    expect(readFileSync(join(vaultDir, foreignPath), 'utf-8'))
      .toContain(`[[${subject.slug}:old-page]]`);
    expect(JSON.parse(readFileSync(join(vaultDir, sidecarPath), 'utf-8')).linkedPages)
      .toEqual(['new-page']);

    expect(pagesRepo.getPageBySlug(subject.id, 'old-page')).toBeNull();
    expect(pagesRepo.getPageBySlug(subject.id, 'new-page')?.title).toBe('Old Title');
    expect(pagesRepo.resolvePageAlias(subject.id, 'old-page')).toBe('new-page');
    expect(pagesRepo.getBacklinks(subject.id, 'new-page').map((entry) => (
      `${entry.subjectId}:${entry.slug}`
    )).sort()).toEqual([
      `${other.id}:foreign`,
      `${subject.id}:new-page`,
      `${subject.id}:notes`,
    ].sort());
    expect(sourcesRepo.getSourcesForPage(subject.id, 'new-page').map((source) => source.id))
      .toEqual(['source-1']);
    expect(sourcesRepo.getSourcesForPage(subject.id, 'old-page')).toEqual([]);
    for (const table of ['page_embeddings', 'page_maturity', 'page_renditions']) {
      expect(db.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE subject_id = ? AND slug = 'old-page'`,
      ).get(subject.id)).toEqual({ n: 0 });
      expect(db.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE subject_id = ? AND slug = 'new-page'`,
      ).get(subject.id)).toEqual({ n: 1 });
    }
    expect(db.prepare(`SELECT slug FROM page_rendition_assets WHERE id = 'old-asset'`).get())
      .toEqual({ slug: 'new-page' });

    renditionsRepo.replaceRendition({
      subjectId: subject.id,
      slug: 'new-page',
      canonicalHash: 'new-hash',
      profileVersion: 3,
      renderedMd: 'new rendition',
      model: null,
      assets: [{ id: 'new-asset', mediaType: 'image/webp', dataBase64: 'Yg==' }],
    });
    expect(renditionsRepo.getRenditionAsset('old-asset')).toBeNull();
    expect(renditionsRepo.getRenditionAsset('new-asset')).not.toBeNull();
  });

  it('重建索引时按目标 Subject 隔离同名标题', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const pagesRepo = await import('../../db/repos/pages-repo');
    const { writeVaultFiles } = await import('../wiki-store');
    const { rebuildPageIndex } = await import('../indexer');

    const suffix = randomUUID().slice(0, 8);
    const current = subjectsRepo.create({ slug: `current-${suffix}`, name: 'Current' });
    const other = subjectsRepo.create({ slug: `other-${suffix}`, name: 'Other' });
    writeVaultFiles([
      {
        path: `wiki/${current.slug}/current-shared.md`,
        content: page('Shared Title', 'Current target.'),
      },
      {
        path: `wiki/${other.slug}/other-shared.md`,
        content: page('Shared Title', 'Other target.'),
      },
      {
        path: `wiki/${current.slug}/source.md`,
        content: page(
          'Source',
          `Local [[Shared Title]] and remote [[${other.slug}:Shared Title]].`,
        ),
      },
    ]);

    rebuildPageIndex();

    expect(pagesRepo.getBacklinks(current.id, 'current-shared')).toEqual([
      expect.objectContaining({ subjectId: current.id, slug: 'source' }),
    ]);
    expect(pagesRepo.getBacklinks(other.id, 'other-shared')).toEqual([
      expect.objectContaining({ subjectId: current.id, slug: 'source' }),
    ]);
  });
});
