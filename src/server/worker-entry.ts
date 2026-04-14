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

// Import service modules to trigger handler registration side effects
import './services/ingest-service';
import './services/lint-service';
import './services/query-service'; // registers 'save-to-wiki' handler

async function main() {
  console.log('Initializing worker...');

  // Eagerly load LLM config to print route table at boot
  const { getLLMConfig } = await import('./llm/config-loader');
  getLLMConfig();

  // Ensure database is ready
  getDb();
  console.log('Database initialized');

  // Self-heal: if pages exist but FTS index is empty, rebuild it
  const sqlite = getRawDb();
  const pageCount = (sqlite.prepare('SELECT COUNT(*) as n FROM pages').get() as { n: number }).n;
  const ftsCount = (sqlite.prepare('SELECT COUNT(*) as n FROM pages_fts').get() as { n: number }).n;
  if (pageCount > 0 && ftsCount === 0) {
    console.log('FTS index empty with existing pages — rebuilding...');
    rebuildSearchIndex();
    console.log('FTS index rebuilt');
  }

  // Crash recovery: reclaim jobs with expired leases from previous worker
  const reclaimed = queue.reclaimExpired();
  if (reclaimed > 0) {
    console.log(`Reclaimed ${reclaimed} expired running job(s)`);
  }

  // Rollback pending (uncommitted) operations from crashed runs
  const pendingOps = sqlite.prepare(
    "SELECT * FROM operations WHERE status = 'pending'"
  ).all() as Array<{
    id: string; job_id: string; pre_head: string; post_head: string | null;
    changeset_json: string; status: string;
  }>;
  for (const op of pendingOps) {
    if (!op.pre_head) continue;
    try {
      const changeset: Changeset = {
        id: op.id,
        jobId: op.job_id,
        entries: JSON.parse(op.changeset_json),
        preHead: op.pre_head,
        postHead: op.post_head,
        status: 'pending',
      };
      await rollbackChangeset(changeset);
      console.log(`Rolled back pending operation ${op.id}`);
    } catch (err) {
      console.error(`Failed to rollback operation ${op.id}:`, err);
    }
  }

  // Ensure vault git repo exists
  await ensureVaultRepo();
  console.log('Vault repository ready');

  // Start the worker polling loop (respect env config)
  const pollMs = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '2000', 10);
  const stop = startWorker(pollMs);
  console.log(`Worker started, polling every ${pollMs}ms`);

  // M1 fix: Graceful shutdown — stop worker AND close DB connection
  function shutdown(signal: string) {
    console.log(`Received ${signal}, stopping worker...`);
    stop();
    try {
      getRawDb().close();
      console.log('Database connection closed');
    } catch { /* already closed */ }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
