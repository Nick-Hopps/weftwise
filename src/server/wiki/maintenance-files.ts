import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getConfig } from '../config/env';
import { ensureVaultRuntimeExcludes } from '../git/vault-runtime-excludes';
import { tryAcquireVaultRecoveryLock } from './vault-mutex';

const MaintenanceEntrySchema = z.object({
  target: z.string().min(1),
  backup: z.string().min(1),
  existed: z.boolean(),
  processed: z.boolean(),
}).strict();

const MaintenanceManifestSchema = z.object({
  version: z.literal(1),
  ownerPid: z.number().int(),
  markerSubjectId: z.string().min(1),
  expectedEpoch: z.number().int().nonnegative(),
  subjectIds: z.array(z.string().min(1)).min(1),
  entries: z.array(MaintenanceEntrySchema).min(1),
}).strict();

type MaintenanceEntry = z.infer<typeof MaintenanceEntrySchema>;
type MaintenanceManifest = z.infer<typeof MaintenanceManifestSchema>;

export interface StageVaultPathsOptions {
  markerSubjectId: string;
  expectedEpoch: number;
  subjectIds: string[];
}

export interface StagedVaultPaths {
  /** DB 事务失败时移除新内容并原位恢复全部旧目录。 */
  restore(): void;
  /** DB 与 vault 已一致后删除临时备份。 */
  discard(): void;
}

/** 维护路径已开始移动，但即时补偿未能完成；必须保留 DB 维护态供启动恢复。 */
export class VaultMaintenanceRestoreError extends Error {
  constructor(
    readonly stageError: unknown,
    readonly restoreError: unknown,
  ) {
    super('Vault maintenance staging failed and compensation is pending');
    this.name = 'VaultMaintenanceRestoreError';
  }
}

const recoveryTimers = new WeakMap<
  Database.Database,
  ReturnType<typeof setTimeout>
>();
const RECOVERY_RETRY_MS = 1_000;

function maintenanceRoot(vaultRoot: string): string {
  return path.join(vaultRoot, '.llm-wiki', 'maintenance');
}

/**
 * 通过同文件系统 rename 暂存待删除目录，使 reset/delete 可在 DB 失败时补偿。
 * manifest 与备份放在 vault 内的 Git exclude 目录，避免 Docker 独立挂载点间
 * rename 触发 EXDEV；进程崩溃后可依据 Subject epoch 自动恢复或丢弃。
 */
export function stageVaultPaths(
  targets: string[],
  options: StageVaultPathsOptions,
): StagedVaultPaths {
  const vaultRoot = path.resolve(getConfig().vaultPath);
  ensureVaultRuntimeExcludes(vaultRoot);
  const uniqueTargets = [...new Set(targets.map((target) => path.resolve(target)))];
  const backupRoot = path.join(maintenanceRoot(vaultRoot), randomUUID());
  const manifestPath = path.join(backupRoot, 'manifest.json');
  const entries: MaintenanceEntry[] = uniqueTargets.map((target) => {
    const relative = path.relative(vaultRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`维护路径不在 vault 内: ${target}`);
    }
    return {
      target,
      backup: path.join(backupRoot, 'files', relative),
      existed: fs.existsSync(target),
      processed: false,
    };
  });
  const manifest: MaintenanceManifest = {
    version: 1,
    ownerPid: process.pid,
    markerSubjectId: options.markerSubjectId,
    expectedEpoch: options.expectedEpoch,
    subjectIds: [...new Set(options.subjectIds)],
    entries,
  };
  if (!validateManifest(manifest, vaultRoot, backupRoot)) {
    throw new Error('维护 manifest 参数无效');
  }

  const persistManifest = () => {
    fs.mkdirSync(backupRoot, { recursive: true });
    const tempPath = `${manifestPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');
    fs.renameSync(tempPath, manifestPath);
  };
  const restore = () => restoreManifest(manifest, backupRoot);

  try {
    persistManifest();
    for (const entry of entries) {
      entry.processed = true;
      persistManifest();
      if (!entry.existed) continue;
      fs.mkdirSync(path.dirname(entry.backup), { recursive: true });
      fs.renameSync(entry.target, entry.backup);
    }
  } catch (error) {
    try {
      restore();
    } catch (restoreError) {
      throw new VaultMaintenanceRestoreError(error, restoreError);
    }
    throw error;
  }

  return {
    restore,
    discard() {
      // 备份已不再承载权威数据；清理失败可由下次启动按 epoch 再次判定。
      try {
        fs.rmSync(backupRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/** 启动恢复：owner 已死亡时，以 marker Subject 是否删除/epoch 是否前进判断提交结果。 */
export function recoverInterruptedVaultMaintenance(
  sqlite: Database.Database,
): boolean {
  const release = tryAcquireVaultRecoveryLock();
  // 任何活跃写锁都可能对应当前维护，不能用 PID namespace 猜测所有者。
  // 定时重试保证应用只启动一次时，新鲜的死锁在 stale 后仍会被恢复。
  if (!release) {
    scheduleRecovery(sqlite);
    return false;
  }

  try {
    const complete = recoverInterruptedVaultMaintenanceWithLock(sqlite);
    if (!complete) {
      scheduleRecovery(sqlite);
      return false;
    }
    return true;
  } finally {
    release();
  }
}

function recoverInterruptedVaultMaintenanceWithLock(
  sqlite: Database.Database,
): boolean {
  const vaultRoot = path.resolve(getConfig().vaultPath);

  const root = maintenanceRoot(vaultRoot);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      names = [];
    } else {
      return false;
    }
  }
  let recoveryIncomplete = false;

  for (const name of names) {
    const backupRoot = path.join(root, name);
    try {
      const stat = fs.lstatSync(backupRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        recoveryIncomplete = true;
        continue;
      }
    } catch {
      recoveryIncomplete = true;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf-8'),
      ) as unknown;
    } catch {
      // 目录可能已搬入备份，manifest 不可读时必须 fail-closed。
      recoveryIncomplete = true;
      continue;
    }
    const manifest = validateManifest(parsed, vaultRoot, backupRoot);
    if (!manifest) {
      recoveryIncomplete = true;
      continue;
    }

    const marker = sqlite.prepare(`
      SELECT mutation_epoch FROM subjects WHERE id = ?
    `).get(manifest.markerSubjectId) as { mutation_epoch: number } | undefined;
    const committed = !marker || marker.mutation_epoch > manifest.expectedEpoch;
    if (committed) {
      try {
        fs.rmSync(backupRoot, { recursive: true, force: true });
      } catch {
        recoveryIncomplete = true;
        continue;
      }
      activateSubjects(sqlite, manifest.subjectIds, false);
    } else {
      try {
        restoreManifest(manifest, backupRoot);
      } catch {
        recoveryIncomplete = true;
        continue;
      }
      // 未提交恢复也必须换代，使维护前已取得的同步写 lease 失效。
      activateSubjects(sqlite, manifest.subjectIds, true);
    }
  }

  // 进程可能在 DB claim 提交后、manifest 首次落盘前退出。没有活跃 vault 锁时，
  // 剩余 resetting 均为孤儿 claim；提升 epoch 后恢复 active，拒绝旧同步写租约。
  if (!recoveryIncomplete) {
    sqlite.prepare(`
      UPDATE subjects
      SET maintenance_state = 'active', mutation_epoch = mutation_epoch + 1
      WHERE maintenance_state = 'resetting'
    `).run();
  }
  return !recoveryIncomplete;
}

function scheduleRecovery(sqlite: Database.Database): void {
  if (recoveryTimers.has(sqlite)) return;
  const timer = setTimeout(() => {
    recoveryTimers.delete(sqlite);
    try {
      recoverInterruptedVaultMaintenance(sqlite);
    } catch {
      // SQLite 已关闭或短暂 IO 错误时不让后台 timer 造成未捕获异常。
      if (sqlite.open) scheduleRecovery(sqlite);
    }
  }, RECOVERY_RETRY_MS);
  timer.unref();
  recoveryTimers.set(sqlite, timer);
}

function validateManifest(
  value: unknown,
  vaultRoot: string,
  backupRoot: string,
): MaintenanceManifest | null {
  const parsed = MaintenanceManifestSchema.safeParse(value);
  if (!parsed.success) return null;
  const manifest = parsed.data;
  if (!manifest.subjectIds.includes(manifest.markerSubjectId)) return null;

  const filesRoot = path.join(backupRoot, 'files');
  const targets = new Set<string>();
  const backups = new Set<string>();
  for (const entry of manifest.entries) {
    const target = path.resolve(entry.target);
    const backup = path.resolve(entry.backup);
    if (!isStrictChild(vaultRoot, target)) return null;
    if (!isStrictChild(filesRoot, backup)) return null;
    const runtimeRoot = path.resolve(maintenanceRoot(vaultRoot));
    if (target === runtimeRoot || isStrictChild(runtimeRoot, target)) return null;
    const expectedBackup = path.resolve(
      filesRoot,
      path.relative(vaultRoot, target),
    );
    if (backup !== expectedBackup) return null;
    if (targets.has(target) || backups.has(backup)) return null;
    targets.add(target);
    backups.add(backup);
  }
  return manifest;
}

function isStrictChild(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative)
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function activateSubjects(
  sqlite: Database.Database,
  subjectIds: string[],
  bumpEpoch: boolean,
): void {
  if (subjectIds.length === 0) return;
  const placeholders = subjectIds.map(() => '?').join(', ');
  sqlite.prepare(`
    UPDATE subjects
    SET maintenance_state = 'active'
      ${bumpEpoch ? ', mutation_epoch = mutation_epoch + 1' : ''}
    WHERE id IN (${placeholders})
  `).run(...subjectIds);
}

function restoreManifest(manifest: MaintenanceManifest, backupRoot: string): void {
  for (const entry of manifest.entries.filter((item) => item.processed)) {
    const backupExists = fs.existsSync(entry.backup);
    if (!entry.existed && !backupExists) {
      fs.rmSync(entry.target, { recursive: true, force: true });
      continue;
    }
    if (!backupExists) continue;
    fs.rmSync(entry.target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(entry.target), { recursive: true });
    fs.renameSync(entry.backup, entry.target);
  }
  fs.rmSync(backupRoot, { recursive: true, force: true });
}
