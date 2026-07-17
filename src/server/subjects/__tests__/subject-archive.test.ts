/**
 * Subject 导出/导入 round-trip 集成测试。
 * 真实临时 vault git 仓库 + 真实临时 SQLite（同 recovery.test.ts 做法）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

let vaultDir: string;
let dbDir: string;
let prevVaultPath: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'archive-vault-'));
  dbDir = mkdtempSync(join(tmpdir(), 'archive-db-'));
  prevVaultPath = process.env.VAULT_PATH;
  prevDbPath = process.env.DATABASE_PATH;
  process.env.VAULT_PATH = vaultDir;
  process.env.DATABASE_PATH = join(dbDir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.VAULT_PATH = prevVaultPath;
  process.env.DATABASE_PATH = prevDbPath;
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

const PAGE = (title: string) =>
  [
    '---',
    `title: ${title}`,
    "created: '2026-01-01T00:00:00.000Z'",
    "updated: '2026-01-01T00:00:00.000Z'",
    'tags: [demo]',
    'sources: []',
    '---',
    '',
    `${title} 正文，引用 [[index]]。`,
  ].join('\n');

async function setup() {
  const { ensureVaultRepo } = await import('@/server/git/git-service');
  const subjectsRepo = await import('@/server/db/repos/subjects-repo');
  const pagesRepo = await import('@/server/db/repos/pages-repo');
  const sourcesRepo = await import('@/server/db/repos/sources-repo');
  const { indexTouchedPages } = await import('@/server/wiki/indexer');
  const archive = await import('@/server/subjects/subject-archive');
  await ensureVaultRepo();
  return { subjectsRepo, pagesRepo, sourcesRepo, indexTouchedPages, ...archive };
}

/** 造一个带 2 页、1 源侧车、1 资产的 subject，并建立索引。 */
function seedVault(slug: string) {
  const wiki = join(vaultDir, 'wiki', slug);
  const raw = join(vaultDir, 'raw', slug);
  const assets = join(vaultDir, 'assets', slug);
  const sidecars = join(vaultDir, '.llm-wiki', 'sources', slug);
  mkdirSync(wiki, { recursive: true });
  mkdirSync(raw, { recursive: true });
  mkdirSync(assets, { recursive: true });
  mkdirSync(sidecars, { recursive: true });
  writeFileSync(join(wiki, 'index.md'), PAGE('Index'));
  writeFileSync(join(wiki, 'alpha.md'), PAGE('Alpha'));
  writeFileSync(join(raw, 'doc.md'), '# 原始文档');
  writeFileSync(join(assets, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(
    join(sidecars, 'src-1.json'),
    JSON.stringify({
      id: 'src-1',
      filename: 'doc.md',
      contentHash: 'hash-1',
      parsedAt: '2026-01-01T00:00:00.000Z',
      metadataJson: '{}',
      linkedPages: ['alpha'],
    }),
  );
}

describe('export → import round-trip', () => {
  it('导入为新 slug 后页面/来源/资产与原 subject 一致', async () => {
    const { subjectsRepo, pagesRepo, sourcesRepo, indexTouchedPages, exportSubjectArchive, importSubjectArchive } =
      await setup();
    const original = subjectsRepo.create({ slug: 'origin', name: 'Origin', description: 'd' });
    seedVault('origin');
    indexTouchedPages(original.id, ['index', 'alpha']);

    const buffer = exportSubjectArchive(original);
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((e) => e.entryName).sort();
    expect(names).toContain('manifest.json');
    expect(names).toContain('wiki/index.md');
    expect(names).toContain('sources/src-1.json');
    expect(names).toContain('assets/pic.png');

    const { subject, stats } = await importSubjectArchive(buffer, { slugOverride: 'copy' });
    expect(subject.slug).toBe('copy');
    expect(subject.name).toBe('Origin');
    expect(stats).toEqual({ pages: 2, sources: 1, assets: 1 });

    // 页面索引一致
    const pages = pagesRepo.getAllPages(subject.id).map((p) => p.slug).sort();
    expect(pages).toEqual(['alpha', 'index']);
    // 侧车恢复 sources + page_sources
    expect(sourcesRepo.getSourcesForPage(subject.id, 'alpha').map((s) => s.id)).toEqual(['src-1']);
    // 文件落到新 slug 目录
    expect(existsSync(join(vaultDir, 'wiki', 'copy', 'alpha.md'))).toBe(true);
    expect(readFileSync(join(vaultDir, 'assets', 'copy', 'pic.png'))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    // FTS 可搜索
    expect(pagesRepo.searchPages(subject.id, 'Alpha').length).toBeGreaterThan(0);
  });

  it('slug 冲突抛 SubjectError 且零落盘', async () => {
    const { subjectsRepo, exportSubjectArchive, importSubjectArchive } = await setup();
    const original = subjectsRepo.create({ slug: 'origin', name: 'Origin' });
    seedVault('origin');
    const buffer = exportSubjectArchive(original);

    await expect(importSubjectArchive(buffer)).rejects.toMatchObject({ code: 'slug-conflict' });
    expect(subjectsRepo.listSubjects().map((s) => s.slug)).not.toContain('origin-copy');
  });

  it('路径穿越 entry 被拒绝且不创建 subject', async () => {
    const { subjectsRepo, importSubjectArchive } = await setup();
    const zip = new AdmZip();
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          exportedAt: 'x',
          subject: { slug: 'evil', name: 'Evil', description: '', augmentationLevel: 'standard' },
        }),
      ),
    );
    zip.addFile('wiki/../../escape.md', Buffer.from('pwn'));
    await expect(importSubjectArchive(zip.toBuffer())).rejects.toMatchObject({
      code: 'invalid-entry',
    });
    expect(subjectsRepo.getBySlug('evil')).toBeNull();
    expect(existsSync(join(vaultDir, '..', 'escape.md'))).toBe(false);
  });

  it('缺 manifest / 非 zip 拒绝', async () => {
    const { importSubjectArchive } = await setup();
    await expect(importSubjectArchive(Buffer.from('not a zip'))).rejects.toMatchObject({
      code: 'invalid-archive',
    });
    const zip = new AdmZip();
    zip.addFile('wiki/a.md', Buffer.from('x'));
    await expect(importSubjectArchive(zip.toBuffer())).rejects.toMatchObject({
      code: 'invalid-manifest',
    });
  });
});
