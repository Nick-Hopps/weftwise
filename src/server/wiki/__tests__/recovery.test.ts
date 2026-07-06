/**
 * recoverPendingOperation 三分支恢复逻辑单测。
 *
 * 用真实临时目录初始化 vault git 仓库 + 真实临时 SQLite（同 indexer-wakeup.test.ts
 * 的做法），手工构造三种 HEAD 状态，断言恢复结果、operations 行与 DB 索引状态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let vaultDir: string;
let dbDir: string;
let prevVaultPath: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'recovery-vault-'));
  dbDir = mkdtempSync(join(tmpdir(), 'recovery-db-'));
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

const PAGE_CONTENT = [
  '---',
  'title: A Page',
  "created: '2026-01-01T00:00:00.000Z'",
  "updated: '2026-01-01T00:00:00.000Z'",
  'tags: []',
  'sources: []',
  '---',
  '',
  '正文。',
].join('\n');

async function setup() {
  const { ensureVaultRepo, getVaultHead, commitVaultChanges } = await import(
    '@/server/git/git-service'
  );
  const { getRawDb } = await import('@/server/db/client');
  const subjectsRepo = await import('@/server/db/repos/subjects-repo');
  const pagesRepo = await import('@/server/db/repos/pages-repo');
  const { writeVaultFiles } = await import('@/server/wiki/wiki-store');
  const { recoverPendingOperation } = await import('@/server/wiki/recovery');

  await ensureVaultRepo();
  const subject = subjectsRepo.create({ slug: `s-${randomUUID().slice(0, 8)}`, name: 'S' });

  return {
    ensureVaultRepo,
    getVaultHead,
    commitVaultChanges,
    getRawDb,
    subjectsRepo,
    pagesRepo,
    writeVaultFiles,
    recoverPendingOperation,
    subject,
  };
}

function insertPendingOperation(
  db: ReturnType<Awaited<ReturnType<typeof setup>>['getRawDb']>,
  changesetId: string,
  jobId: string,
  subjectId: string,
  preHead: string,
  entries: unknown
) {
  db
    .prepare(
      `INSERT INTO operations (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
       VALUES (?, ?, ?, ?, NULL, ?, 'pending')`
    )
    .run(changesetId, jobId, subjectId, preHead, JSON.stringify(entries));
}

describe('recoverPendingOperation', () => {
  it('分支1 前滚：HEAD commit message 含 [cs:<id>] → 补 postHead + applied + 重建索引', async () => {
    const {
      getVaultHead,
      commitVaultChanges,
      getRawDb,
      pagesRepo,
      writeVaultFiles,
      recoverPendingOperation,
      subject,
    } = await setup();

    const db = getRawDb();
    const preHead = await getVaultHead();
    const changesetId = randomUUID();
    const relPath = `wiki/${subject.slug}/a.md`;
    const entries = [{ action: 'create', path: relPath, content: PAGE_CONTENT }];

    insertPendingOperation(db, changesetId, 'job-1', subject.id, preHead, entries);

    // 模拟"commit 已成功但进程在状态落库前崩溃"：直接写文件 + commit 打标记，
    // 但不更新 operations 行（保持 pending）。
    writeVaultFiles([{ path: relPath, content: PAGE_CONTENT }]);
    const postHead = await commitVaultChanges(
      `[subject:${subject.slug}] Apply changeset ${changesetId} (job: job-1) [cs:${changesetId}]`,
      [relPath]
    );
    expect(postHead).not.toBe(preHead);

    const outcome = await recoverPendingOperation({
      id: changesetId,
      jobId: 'job-1',
      subjectId: subject.id,
      subjectSlug: subject.slug,
      entries: entries as never,
      preHead,
      postHead: null,
      status: 'pending',
    });

    expect(outcome).toBe('rolled-forward');

    const row = db
      .prepare(`SELECT status, post_head FROM operations WHERE id = ?`)
      .get(changesetId) as { status: string; post_head: string };
    expect(row.status).toBe('applied');
    expect(row.post_head).toBe(postHead);

    // 索引应已经幂等重建：页面在 DB 中可查到
    const page = pagesRepo.getPageBySlug(subject.id, 'a');
    expect(page).not.toBeNull();

    // vault 文件仍在（前滚不应回退/删除任何东西）
    const { readPageInSubject } = await import('@/server/wiki/wiki-store');
    expect(readPageInSubject(subject.slug, 'a')).not.toBeNull();
  });

  it('分支2 回滚：HEAD 未打标记且仍等于 preHead → 走常规 rollbackChangeset', async () => {
    const { getVaultHead, getRawDb, pagesRepo, recoverPendingOperation, subject } = await setup();

    const db = getRawDb();
    const preHead = await getVaultHead();
    const changesetId = randomUUID();
    const relPath = `wiki/${subject.slug}/b.md`;
    const entries = [{ action: 'create', path: relPath, content: PAGE_CONTENT }];

    insertPendingOperation(db, changesetId, 'job-2', subject.id, preHead, entries);

    // 崩溃发生在 git commit 之前：文件从未写入、HEAD 仍是 preHead。
    const outcome = await recoverPendingOperation({
      id: changesetId,
      jobId: 'job-2',
      subjectId: subject.id,
      subjectSlug: subject.slug,
      entries: entries as never,
      preHead,
      postHead: null,
      status: 'pending',
    });

    expect(outcome).toBe('rolled-back');

    const row = db
      .prepare(`SELECT status FROM operations WHERE id = ?`)
      .get(changesetId) as { status: string };
    expect(row.status).toBe('rolled-back');

    const headAfter = await getVaultHead();
    expect(headAfter).toBe(preHead);

    const page = pagesRepo.getPageBySlug(subject.id, 'b');
    expect(page).toBeNull();
  });

  it('分支3 孤儿：HEAD 未打标记且已不等于 preHead（后续已有其他提交）→ 不 restoreToHead，只标终态', async () => {
    const { getVaultHead, commitVaultChanges, getRawDb, writeVaultFiles, recoverPendingOperation, subject } =
      await setup();

    const db = getRawDb();
    const preHead = await getVaultHead();
    const changesetId = randomUUID();
    const relPath = `wiki/${subject.slug}/c.md`;
    const entries = [{ action: 'create', path: relPath, content: PAGE_CONTENT }];

    insertPendingOperation(db, changesetId, 'job-3', subject.id, preHead, entries);

    // 模拟"之后已有别的提交落地"：另一个不相关的文件被写入并提交，且不含本 changeset 的标记。
    const otherPath = `wiki/${subject.slug}/other.md`;
    writeVaultFiles([{ path: otherPath, content: PAGE_CONTENT }]);
    const laterHead = await commitVaultChanges(
      `[subject:${subject.slug}] Apply changeset ${randomUUID()} (job: job-later)`,
      [otherPath]
    );
    expect(laterHead).not.toBe(preHead);

    const outcome = await recoverPendingOperation({
      id: changesetId,
      jobId: 'job-3',
      subjectId: subject.id,
      subjectSlug: subject.slug,
      entries: entries as never,
      preHead,
      postHead: null,
      status: 'pending',
    });

    expect(outcome).toBe('orphaned');

    const row = db
      .prepare(`SELECT status FROM operations WHERE id = ?`)
      .get(changesetId) as { status: string };
    expect(row.status).toBe('rolled-back');

    // HEAD 必须原封不动，后续提交（other.md）不能被冲掉。
    const headAfterRecovery = await getVaultHead();
    expect(headAfterRecovery).toBe(laterHead);

    const { readPageInSubject } = await import('@/server/wiki/wiki-store');
    expect(readPageInSubject(subject.slug, 'other')).not.toBeNull();
  });
});
