import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  commitVaultChanges,
  commitStagedVaultChanges,
  listStagedVaultFiles,
  listTrackedVaultFiles,
} from '../git/git-service';
import { acquireVaultLock } from '../wiki/vault-mutex';

type RemoveFile = (file: string) => void;

export interface SourceDedupCleanupResult {
  completedLoserIds: string[];
  writtenPaths: string[];
  deletedPaths: string[];
}

/**
 * 重试 migration/runtime 并发产生的精确 loser sidecar 清理记录。
 * 先把 loser 中的权威元数据合并到 winner，再删除两个 loser 路径；
 * 任一步失败都保留记录到下次启动。
 */
export function cleanupSourceDedupSidecars(
  sqlite: Database.Database,
  vaultRoot: string,
  removeFile: RemoveFile = (file) => fs.rmSync(file, { force: true }),
): SourceDedupCleanupResult {
  const exists = sqlite.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_dedup_cleanup'
  `).get();
  if (!exists) {
    return { completedLoserIds: [], writtenPaths: [], deletedPaths: [] };
  }

  const rows = sqlite.prepare(`
    SELECT loser_id, winner_id, subject_slug, filename
    FROM source_dedup_cleanup
    ORDER BY loser_id
  `).all() as Array<{
    loser_id: string;
    winner_id: string;
    subject_slug: string;
    filename: string;
  }>;
  const completedLoserIds: string[] = [];
  const writtenPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  for (const row of rows) {
    const loserPaths = [
      path.join(
        vaultRoot,
        '.llm-wiki',
        'sources',
        row.subject_slug,
        `${row.loser_id}.json`,
      ),
      path.join(
        vaultRoot,
        '.llm-wiki',
        'sources',
        `${row.loser_id}.json`,
      ),
    ];
    for (const loserPath of loserPaths) {
      if (fs.existsSync(loserPath)) deletedPaths.add(vaultRelative(vaultRoot, loserPath));
    }
    try {
      const winnerPath = mergeWinnerSidecar(vaultRoot, row);
      if (winnerPath) writtenPaths.add(vaultRelative(vaultRoot, winnerPath));
      for (const loserPath of loserPaths) removeFile(loserPath);
      completedLoserIds.push(row.loser_id);
    } catch {
      // 保留补偿记录，下一次启动继续尝试。
    }
  }

  return {
    completedLoserIds,
    writtenPaths: [...writtenPaths].sort(),
    deletedPaths: [...deletedPaths].sort(),
  };
}

/** Git 提交成功后才消费 ledger，避免后续 reset --hard 使文件与 DB 断链。 */
export function finalizeSourceDedupCleanup(
  sqlite: Database.Database,
  loserIds: string[],
): void {
  if (loserIds.length === 0) return;
  sqlite.transaction(() => {
    const remove = sqlite.prepare(`
      DELETE FROM source_dedup_cleanup WHERE loser_id = ?
    `);
    for (const loserId of loserIds) remove.run(loserId);
    const remaining = sqlite.prepare(`
      SELECT 1 FROM source_dedup_cleanup LIMIT 1
    `).get();
    if (!remaining) sqlite.exec(`DROP TABLE source_dedup_cleanup`);
  }).immediate();
}

/**
 * worker 启动恢复 pending operation 之后调用：锁内修复 sidecar、提交 vault Git，
 * 最后才消费 DB ledger。任何中断点均可在下次启动幂等重放。
 */
export async function reconcileSourceDedupSidecars(
  sqlite: Database.Database,
  vaultRoot: string,
  options: { vaultLockHeld?: boolean } = {},
): Promise<number> {
  const release = options.vaultLockHeld ? null : await acquireVaultLock();
  try {
    const replayStaged = await assertStagedFilesBelongToDedup(sqlite);
    const result = cleanupSourceDedupSidecars(sqlite, vaultRoot);
    // 已删除但从未 tracked 的 loser 不能直接传给 `git add`，否则 pathspec
    // 不匹配会让整个补偿失败。只提交 index 中真实存在的删除项。
    const trackedDeletes = await listTrackedVaultFiles(result.deletedPaths);
    const commitPaths = [...new Set([
      ...result.writtenPaths,
      ...trackedDeletes,
    ])].sort();
    if (commitPaths.length > 0) {
      await commitVaultChanges(
        '维护：合并重复来源元数据',
        commitPaths,
      );
    } else if (replayStaged.length > 0) {
      await commitStagedVaultChanges('维护：合并重复来源元数据');
    }
    const stagedAfterCommit = await listStagedVaultFiles();
    if (stagedAfterCommit.length > 0) {
      throw new Error(
        `来源去重提交后 Git index 仍有 staged 文件: ${stagedAfterCommit.join(', ')}`,
      );
    }
    finalizeSourceDedupCleanup(sqlite, result.completedLoserIds);
    const ledgerExists = sqlite.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'source_dedup_cleanup'
    `).get();
    if (ledgerExists) {
      const remaining = sqlite.prepare(`
        SELECT COUNT(*) AS count FROM source_dedup_cleanup
      `).get() as { count: number };
      if (remaining.count > 0) {
        throw new Error(
          `来源 sidecar 去重仍有 ${remaining.count} 条补偿记录，拒绝启动 worker`,
        );
      }
    }
    return result.completedLoserIds.length;
  } finally {
    release?.();
  }
}

async function assertStagedFilesBelongToDedup(
  sqlite: Database.Database,
): Promise<string[]> {
  const staged = await listStagedVaultFiles();
  if (staged.length === 0) return [];
  const ledgerExists = sqlite.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'source_dedup_cleanup'
  `).get();
  if (!ledgerExists) {
    throw new Error(`Vault Git index 含未归属 staged 文件: ${staged.join(', ')}`);
  }
  const rows = sqlite.prepare(`
    SELECT loser_id, winner_id, subject_slug FROM source_dedup_cleanup
  `).all() as Array<{
    loser_id: string;
    winner_id: string;
    subject_slug: string;
  }>;
  const allowed = new Set<string>();
  for (const row of rows) {
    allowed.add(`.llm-wiki/sources/${row.subject_slug}/${row.winner_id}.json`);
    allowed.add(`.llm-wiki/sources/${row.subject_slug}/${row.loser_id}.json`);
    allowed.add(`.llm-wiki/sources/${row.loser_id}.json`);
  }
  const unrelated = staged.filter((file) => !allowed.has(file));
  if (unrelated.length > 0) {
    throw new Error(
      `Vault Git index 含非来源去重 staged 文件: ${unrelated.join(', ')}`,
    );
  }
  return staged;
}

function mergeWinnerSidecar(
  vaultRoot: string,
  row: {
    loser_id: string;
    winner_id: string;
    subject_slug: string;
    filename: string;
  },
): string | null {
  const root = path.join(vaultRoot, '.llm-wiki', 'sources');
  const winnerPaths = [
    path.join(root, row.subject_slug, `${row.winner_id}.json`),
    path.join(root, `${row.winner_id}.json`),
  ];
  const loserPaths = [
    path.join(root, row.subject_slug, `${row.loser_id}.json`),
    path.join(root, `${row.loser_id}.json`),
  ];
  const winnerDocuments = winnerPaths.map(readMetadata).filter(isMetadata);
  const loserDocuments = loserPaths.map(readMetadata).filter(isMetadata);
  const documents = [...winnerDocuments, ...loserDocuments];
  if (documents.length === 0) return null;

  const base: Record<string, unknown> = {};
  // winner 优先；对 winner 缺失的任意历史字段按稳定路径顺序从 loser 回填。
  for (const document of documents) {
    for (const key of Object.keys(document).sort()) {
      if (base[key] === undefined || base[key] === null || base[key] === '') {
        base[key] = document[key];
      }
    }
  }
  const linkedPages = [...new Set(documents.flatMap((document) => (
    Array.isArray(document.linkedPages)
      ? document.linkedPages.filter((value): value is string => typeof value === 'string')
      : []
  )))].sort();
  const chunks = documents.find((document) => (
    Array.isArray(document.chunks) && document.chunks.length > 0
  ))?.chunks;
  const savedAt = documents
    .map((document) => document.savedAt)
    .filter((value): value is string => typeof value === 'string')
    .sort()[0];
  const merged: Record<string, unknown> = {
    ...base,
    id: row.winner_id,
    subjectSlug: row.subject_slug,
    filename: row.filename,
  };
  if (linkedPages.length > 0) merged.linkedPages = linkedPages;
  if (
    (!Array.isArray(merged.chunks) || merged.chunks.length === 0)
    && chunks
  ) merged.chunks = chunks;
  if (savedAt) merged.savedAt = savedAt;

  const target = winnerPaths[0];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(temp, target);
    return target;
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 保留主错误，cleanup ledger 会在下次启动重试。
    }
    throw error;
  }
}

function vaultRelative(vaultRoot: string, file: string): string {
  return path.relative(vaultRoot, file).split(path.sep).join('/');
}

function readMetadata(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return isMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isMetadata(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
