/**
 * Standalone worker process entry point.
 * Run via: npx tsx src/server/worker-entry.ts
 *
 * Initializes the database, registers job handlers, and starts the polling loop.
 */

// Ensure .env is loaded — fallback for when --env-file flag is unavailable
try { process.loadEnvFile(); } catch { /* already loaded or unsupported */ }

import { getDb, getRawDb } from './db/client';
import { ensureVaultRepo } from './git/git-service';
import { startWorker } from './jobs/worker';
import * as queue from './jobs/queue';
import { rebuildSearchIndex } from './wiki/indexer';
import { rollbackChangeset } from './wiki/wiki-transaction';
import type { Changeset } from '@/lib/contracts';

import { join } from 'node:path';
import { vaultPath } from './config/env';
import { buildSkillRegistry } from './agents/skills/registry';
import { createToolRegistry } from './agents/tools/registry';
import type { ToolDef } from './agents/types';
import { vaultReadTool } from './agents/tools/builtin/vault-read';
import { vaultSearchTool } from './agents/tools/builtin/vault-search';
import { commitChangesetTool } from './agents/tools/builtin/commit-changeset';
import { dispatchSkillTool } from './agents/tools/builtin/dispatch-skill';
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

const log = createLogger('worker');

async function bootRuntime(): Promise<void> {
  const skillRegistry = await buildSkillRegistry({
    vaultDir: vaultPath(),
    examplesDir: join(process.cwd(), 'examples', 'skills'),
  });
  const degraded = skillRegistry.degraded();
  if (degraded.length) {
    log.warn('degraded skills:', degraded);
  } else {
    log.info(`loaded ${skillRegistry.list().length} skill(s)`);
  }

  const toolRegistry = createToolRegistry();
  toolRegistry.register(vaultReadTool as ToolDef);
  toolRegistry.register(vaultSearchTool as ToolDef);
  toolRegistry.register(commitChangesetTool as ToolDef);
  toolRegistry.register(dispatchSkillTool as ToolDef);

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

  // Rollback pending (uncommitted) operations from crashed runs.
  // Reconstruct the full Changeset (incl. subject metadata) so the rollback
  // path can reindex the right subject.
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
  const subjectsRepo = await import('./db/repos/subjects-repo');
  for (const op of pendingOps) {
    if (!op.pre_head) continue;
    try {
      const subject = op.subject_id ? subjectsRepo.getById(op.subject_id) : null;
      if (!subject) {
        log.warn(`Skipping operation ${op.id}: subject ${op.subject_id} no longer exists`);
        continue;
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
      await rollbackChangeset(changeset);
      log.info(`Rolled back pending operation ${op.id} (subject: ${subject.slug})`);
    } catch (err) {
      log.error(`Failed to rollback operation ${op.id}:`, err);
    }
  }

  // Ensure vault git repo exists
  await ensureVaultRepo();
  log.info('Vault repository ready');

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

  // M1 fix: Graceful shutdown — stop worker AND close DB connection
  async function shutdown(signal: string) {
    log.info(`Received ${signal}, stopping worker...`);
    stop();
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
