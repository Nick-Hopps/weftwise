import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/server/services/pending-action-maintenance', () => ({
  maintainPendingActions: vi.fn(() => ({ expired: 0, recovered: 0, pruned: 0 })),
}));
vi.mock('@/server/services/maintenance-scheduler', () => ({
  runMaintenanceSweep: vi.fn(() => 0),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  pruneOldOperations: vi.fn(() => 0),
}));
vi.mock('@/server/services/research-provenance-reconciler', () => ({
  reconcileResearchProvenance: vi.fn(() => 0),
  reconcileResearchProvenanceForJob: vi.fn(),
}));
vi.mock('@/server/db/repos/usage-repo', () => ({
  pruneOldUsage: vi.fn(() => 0),
  USAGE_RETENTION_MS: 90 * 24 * 60 * 60_000,
}));
vi.mock('@/server/db/repos/settings-repo', () => ({
  getMaintenanceEnabled: vi.fn(() => false),
  getMaintenanceSweepIntervalHours: vi.fn(() => 24),
  getMaintenanceMaxPagesPerSweep: vi.fn(() => 10),
  getMaintenanceLastSweepAt: vi.fn(() => null),
  setMaintenanceLastSweepAt: vi.fn(),
  getIngestConcurrency: vi.fn(() => 1),
}));

let dir: string;
let previousDb: string | undefined;
let stopWorker: (() => void) | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-terminal-'));
  previousDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
  vi.resetModules();
});

afterEach(() => {
  stopWorker?.();
  stopWorker = null;
  vi.useRealTimers();
  process.env.DATABASE_PATH = previousDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('Worker / Saga 失败终态一致性（真实 SQLite）', () => {
  it('业务事件完成后先落 failed 状态，再追加唯一 job:failed 终态事件', async () => {
    const queue = await import('../queue');
    const worker = await import('../worker');
    const jobsRepo = await import('../../db/repos/jobs-repo');
    const { getRawDb } = await import('../../db/client');
    const job = queue.enqueue('lint', {}, null);

    // 若 Worker 在 jobs.status 仍为 running 时插入 job:failed，本 trigger 会让测试直接失败。
    getRawDb().exec(`
      CREATE TRIGGER assert_failed_status_before_event
      BEFORE INSERT ON job_events
      WHEN NEW.type = 'job:failed'
        AND COALESCE((SELECT status FROM jobs WHERE id = NEW.job_id), '') <> 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'job:failed emitted before failed status');
      END;
    `);

    worker.registerHandler('lint', async (_claimed, emit) => {
      emit('saga:apply', 'Applying changeset');
      emit('saga:rollback', 'Rollback completed');
      throw new Error('Saga commit failed');
    });
    stopWorker = worker.startWorker(10);

    await vi.advanceTimersByTimeAsync(10);

    expect(queue.get(job.id)).toMatchObject({
      status: 'failed',
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
    const persisted = queue.get(job.id)!;
    expect(persisted.completedAt).not.toBeNull();
    expect(JSON.parse(persisted.resultJson!)).toMatchObject({
      error: { message: 'Saga commit failed' },
    });
    expect(jobsRepo.getJobEvents(job.id).map((event) => event.type)).toEqual([
      'saga:apply',
      'saga:rollback',
      'job:failed',
    ]);
  });
});
