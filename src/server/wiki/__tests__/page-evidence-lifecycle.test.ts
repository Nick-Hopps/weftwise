import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let vaultDir: string;
let dbDir: string;
let previousVault: string | undefined;
let previousDb: string | undefined;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'evidence-lifecycle-vault-'));
  dbDir = mkdtempSync(join(tmpdir(), 'evidence-lifecycle-db-'));
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

describe('证据随页面生命周期闭合', () => {
  it('删页清空证据，重建同名 slug 从零开始（不复活旧掌握度）', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const evidenceRepo = await import('../../db/repos/evidence-repo');
    const { writeVaultFiles, deleteVaultFile } = await import('../wiki-store');
    const { indexTouchedPages } = await import('../indexer');

    const subject = subjectsRepo.create({
      slug: `life-${randomUUID().slice(0, 8)}`,
      name: 'Life',
    });
    const path = `wiki/${subject.slug}/topic.md`;

    writeVaultFiles([{ path, content: page('Topic', 'Body.') }]);
    indexTouchedPages(subject.id, ['topic']);

    evidenceRepo.appendEvidence({
      userId: 'local', subjectId: subject.id, slug: 'topic', kind: 'quiz-correct', strength: 'strong',
    });
    expect(evidenceRepo.listForPage('local', subject.id, 'topic')).toHaveLength(1);

    // 删页：文件消失后重索引，走 indexTouchedPages 的删除分支
    deleteVaultFile(path);
    indexTouchedPages(subject.id, ['topic']);
    expect(evidenceRepo.listForPage('local', subject.id, 'topic')).toHaveLength(0);

    // 重建同名 slug —— 这是 page_rendition_assets 踩过的那个坑：
    // 旧派生数据若残留，新页一上来就顶着上一任读者的掌握度。
    writeVaultFiles([{ path, content: page('Topic', 'Rewritten body.') }]);
    indexTouchedPages(subject.id, ['topic']);
    expect(evidenceRepo.listForPage('local', subject.id, 'topic')).toHaveLength(0);
  });
});
