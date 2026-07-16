import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let vaultDir: string;
let dbDir: string;
let previousVault: string | undefined;
let previousDb: string | undefined;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'tag-governance-vault-'));
  dbDir = mkdtempSync(join(tmpdir(), 'tag-governance-db-'));
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

function page(title: string, tags: string[]): string {
  return [
    '---',
    `title: ${title}`,
    "created: '2026-01-01T00:00:00.000Z'",
    "updated: '2026-01-01T00:00:00.000Z'",
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    'sources: []',
    '---',
    '',
    `Body ${title}`,
  ].join('\n');
}

describe('Tags 工作台审批集成', () => {
  it('预览零写入，批准后一次 Saga 更新 Vault/SQLite/Git 并持久化审批终态', async () => {
    const subjectsRepo = await import('../../db/repos/subjects-repo');
    const pagesRepo = await import('../../db/repos/pages-repo');
    const pendingRepo = await import('../../db/repos/pending-actions-repo');
    const { ensureVaultRepo, commitVaultChanges, getVaultHead } = await import('../../git/git-service');
    const { writeVaultFiles } = await import('../../wiki/wiki-store');
    const { rebuildPageIndex } = await import('../../wiki/indexer');
    const { parseFrontmatter } = await import('../../wiki/frontmatter');
    const {
      approvePendingAction,
      createTagBatchPendingActionPreview,
    } = await import('../pending-action-service');

    await ensureVaultRepo();
    const suffix = randomUUID().slice(0, 8);
    const subject = subjectsRepo.create({ slug: `tags-${suffix}`, name: 'Tags' });
    const onePath = `wiki/${subject.slug}/one.md`;
    const twoPath = `wiki/${subject.slug}/two.md`;
    const indexPath = `wiki/${subject.slug}/index.md`;
    writeVaultFiles([
      { path: onePath, content: page('One', ['old', 'topic']) },
      { path: twoPath, content: page('Two', ['canonical', 'old']) },
      { path: indexPath, content: page('Index', ['meta', 'old']) },
    ]);
    await commitVaultChanges('seed tag governance', [onePath, twoPath, indexPath]);
    rebuildPageIndex();
    const seedHead = await getVaultHead();

    const preview = await createTagBatchPendingActionPreview({
      subject,
      payload: { action: 'merge', sourceTag: 'old', targetTag: 'canonical' },
      now: new Date('2026-07-16T00:00:00.000Z'),
    });
    expect(preview).toMatchObject({
      conversationId: null,
      operation: 'tag-batch',
      status: 'pending',
      affectedPages: [
        { slug: 'one', action: 'update' },
        { slug: 'two', action: 'update' },
      ],
    });
    expect(preview.diff).toContain('-  - old');
    expect(await getVaultHead()).toBe(seedHead);
    expect(pagesRepo.getPageBySlug(subject.id, 'one')?.tags).toEqual(['old', 'topic']);

    const applied = await approvePendingAction({
      id: preview.actionId,
      subject,
      now: new Date('2026-07-16T00:01:00.000Z'),
    });
    expect(applied).toMatchObject({ status: 'applied', operation: 'tag-batch' });
    expect(applied.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getVaultHead()).not.toBe(seedHead);
    expect(pagesRepo.getPageBySlug(subject.id, 'one')?.tags).toEqual(['canonical', 'topic']);
    expect(pagesRepo.getPageBySlug(subject.id, 'two')?.tags).toEqual(['canonical']);
    expect(pendingRepo.getScoped(preview.actionId, subject.id)?.status).toBe('applied');

    const index = parseFrontmatter(readFileSync(join(vaultDir, indexPath), 'utf-8'));
    expect(index.data.tags).toEqual(['meta', 'old']);
  });
});
