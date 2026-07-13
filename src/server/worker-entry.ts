/**
 * Standalone worker process entry point.
 * Run via: npx tsx src/server/worker-entry.ts
 *
 * Initializes the database, registers job handlers, and starts the polling loop.
 */

// Ensure .env is loaded — fallback for when --env-file flag is unavailable
try { process.loadEnvFile(); } catch { /* already loaded or unsupported */ }

import { getDb, getRawDb } from './db/client';
import { ensureVaultRepo, getVaultGit } from './git/git-service';
import { startWorker, runningJobCount } from './jobs/worker';
import * as queue from './jobs/queue';
import { rebuildSearchIndex } from './wiki/indexer';
import { recoverPendingOperation } from './wiki/recovery';
import {
  recoverInterruptedVaultMaintenance,
} from './wiki/maintenance-files';
import { acquireVaultLock } from './wiki/vault-mutex';
import { reconcileSourceDedupSidecars } from './sources/source-dedup-cleanup';
import type { Changeset } from '@/lib/contracts';

import { join } from 'node:path';
import { vaultPath } from './config/env';
import { buildSkillRegistry } from './agents/skills/registry';
import { createBuiltinToolRegistry } from './agents/tools/builtin';
import { setRuntimeRegistries } from './worker-runtime';
import { createLogger } from './logging';

// Import service modules to trigger handler registration side effects
import './services/ingest-service';
import './services/lint-service';
import './services/query-service'; // registers 'save-to-wiki' handler
import './services/embedding-service';
import './services/curate-service';
import './services/reenrich-service';
import './services/fix-service';
import './services/research-service';

const log = createLogger('worker');

async function bootRuntime(): Promise<void> {
  const skillRegistry = await buildSkillRegistry({
    vaultDir: vaultPath(),
    examplesDir: join(process.cwd(), 'examples', 'skills'),
    onWarning: (message, detail) => log.warn(message, detail),
  });
  const degraded = skillRegistry.degraded();
  if (degraded.length) {
    log.warn('degraded skills:', degraded);
  } else {
    log.info(`loaded ${skillRegistry.list().length} skill(s)`);
  }

  const toolRegistry = createBuiltinToolRegistry();

  setRuntimeRegistries({ skillRegistry, toolRegistry });
}

async function main() {
  log.info('Initializing worker...');

  // Eagerly load LLM config to print route table at boot
  const { getLLMConfig } = await import('./llm/config-loader');
  getLLMConfig();

  // Ensure database is ready
  getDb();
  log.info('Database initialized');

  // Self-heal: if pages exist but FTS index is empty, rebuild it
  const sqlite = getRawDb();
  while (!recoverInterruptedVaultMaintenance(sqlite)) {
    log.warn('Vault maintenance recovery is waiting for the active lock or a readable manifest');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  // Git 初始化也是 vault 写操作；与 Web/Saga 共用同一跨进程锁。
  const releaseVault = await acquireVaultLock();
  try {
    const pendingBeforeGitInit = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM operations WHERE status = 'pending'
    `).get() as { count: number };
    if (pendingBeforeGitInit.count > 0) {
      // 无 HEAD 时 ensureVaultRepo 会 `git add .`创建初始提交；若同时存在 pending
      // operation，这会把崩溃残留页面误包进初始提交，因此必须先 fail-closed。
      const existingHead = await getVaultGit()
        .log({ maxCount: 1 })
        .then((result) => result.latest?.hash ?? null)
        .catch(() => null);
      if (!existingHead) {
        throw new Error(
          `Vault 无可恢复 HEAD，但存在 ${pendingBeforeGitInit.count} 条 pending operation`,
        );
      }
    }
    await ensureVaultRepo();
  } finally {
    releaseVault();
  }
  log.info('Vault repository ready');

  const pageCount = (sqlite.prepare('SELECT COUNT(*) as n FROM pages').get() as { n: number }).n;
  const ftsCount = (sqlite.prepare('SELECT COUNT(*) as n FROM pages_fts').get() as { n: number }).n;
  if (pageCount > 0 && ftsCount === 0) {
    log.info('FTS index empty with existing pages — rebuilding...');
    rebuildSearchIndex();
    log.info('FTS index rebuilt');
  }

  // Crash recovery: reclaim jobs with expired leases from previous worker
  const reclaimed = queue.reclaimExpired();
  if (reclaimed > 0) {
    log.info(`Reclaimed ${reclaimed} expired running job(s)`);
  }

  // Recover pending operations left behind by crashed runs. A `pending`
  // operation does NOT necessarily mean the commit failed — the process may
  // have crashed between a successful `git commit` and the `status='applied'`
  // write. Reconstruct the full Changeset (incl. subject metadata) and let
  // recoverPendingOperation() decide: roll forward / roll back / leave as an
  // orphan (see src/server/wiki/recovery.ts for the three-branch rationale).
  const subjectsRepo = await import('./db/repos/subjects-repo');
  const releaseRecovery = await acquireVaultLock();
  let dedupedSources = 0;
  try {
    const pendingOps = sqlite.prepare(
      "SELECT * FROM operations WHERE status = 'pending'"
    ).all() as Array<{
      id: string;
      job_id: string;
      subject_id: string | null;
      pre_head: string;
      post_head: string | null;
      changeset_json: string;
      status: string;
    }>;
    for (const op of pendingOps) {
      if (!op.pre_head) {
        // applyChangeset 在写任何 vault 文件前就会回写 pre_head；空值只能是
        // 更早的崩溃窗口，可直接终结，但不能静默 skip 留下 pending。
        sqlite.prepare(`
          UPDATE operations SET status = 'rolled-back' WHERE id = ?
        `).run(op.id);
        log.warn(`Marked pre-write operation ${op.id} as rolled-back (missing pre_head)`);
        continue;
      }
      const subject = op.subject_id ? subjectsRepo.getById(op.subject_id) : null;
      if (!subject) {
        throw new Error(
          `Cannot recover operation ${op.id}: subject ${op.subject_id} no longer exists`,
        );
      }
      const changeset: Changeset = {
        id: op.id,
        jobId: op.job_id,
        subjectId: subject.id,
        subjectSlug: subject.slug,
        entries: JSON.parse(op.changeset_json),
        preHead: op.pre_head,
        postHead: op.post_head,
        status: 'pending',
      };
      const outcome = await recoverPendingOperation(changeset);
      log.info(`Recovered pending operation ${op.id} (subject: ${subject.slug}): ${outcome}`);
    }

    const remainingPending = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM operations WHERE status = 'pending'
    `).get() as { count: number };
    if (remainingPending.count > 0) {
      throw new Error(
        `Pending operation 恢复未完成，剩余 ${remainingPending.count} 条，拒绝启动 worker`,
      );
    }

    // DB source 去重的 sidecar 补偿必须晚于 pending operation 恢复；
    // 两者共用同一 vault 锁，防止 Web 写入在 index 检查与专用 commit 之间插入。
    dedupedSources = await reconcileSourceDedupSidecars(
      sqlite,
      vaultPath(),
      { vaultLockHeld: true },
    );
  } finally {
    releaseRecovery();
  }
  if (dedupedSources > 0) {
    log.info(`Reconciled ${dedupedSources} duplicate source sidecar(s)`);
  }

  // Self-heal: 启动时为每个 subject 入队 embed-index 回填存量向量
  // （handler 未配置 embedding 时 no-op，永远安全）
  try {
    const { enqueueEmbedIndex } = await import('./services/embedding-service');
    for (const s of subjectsRepo.listSubjects()) enqueueEmbedIndex(s.id);
  } catch (err) {
    log.warn('embed-index self-heal enqueue failed', err);
  }

  // Boot agent runtime (skills + tools)
  await bootRuntime();

  // Start the worker polling loop (respect env config)
  const pollMs = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '2000', 10);
  const stop = startWorker(pollMs);
  log.info(`Worker started, polling every ${pollMs}ms`);

  // M1 fix: Graceful shutdown — stop worker, drain in-flight jobs, then close DB connection
  const DRAIN_INTERVAL_MS = 500;
  const DRAIN_TIMEOUT_MS = 30_000;
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) {
      // 重复信号：直接强退（按现有代码风格，第二次不再等待）
      log.warn(`Received ${signal} again during shutdown, forcing exit`);
      process.exit(0);
    }
    shuttingDown = true;
    log.info(`Received ${signal}, stopping worker...`);
    stop();

    // Drain：等待在飞任务清空，最多 30 秒，超时则照常退出（crash-recovery 兜底）
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (runningJobCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_INTERVAL_MS));
    }
    const remaining = runningJobCount();
    if (remaining > 0) {
      log.warn(`[shutdown] drain timeout, ${remaining} job(s) still running`);
    } else {
      log.info('[shutdown] drain complete, no jobs running');
    }

    try {
      getRawDb().close();
      log.info('Database connection closed');
    } catch { /* already closed */ }
    process.exit(0);
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((err) => {
  log.error('Worker failed to start:', err);
  process.exit(1);
});
