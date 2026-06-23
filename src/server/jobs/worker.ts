import * as queue from './queue';
import * as events from './events';
import type { Job } from '@/lib/contracts';
import { runMaintenanceSweep } from '../services/maintenance-scheduler';
import {
  getMaintenanceEnabled,
  getMaintenanceSweepIntervalHours,
  getMaintenanceMaxPagesPerSweep,
  getMaintenanceLastSweepAt,
  setMaintenanceLastSweepAt,
} from '../db/repos/settings-repo';

type JobHandler = (
  job: Job,
  emit: (
    type: string,
    message: string,
    data?: Record<string, unknown>
  ) => void
) => Promise<Record<string, unknown>>;

const handlers = new Map<string, JobHandler>();

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const MAINTENANCE_TICK_MS = 60_000; // 每分钟检查一次节律闸门（实际扫描受 intervalHours 控制）

/** 维护节律闸门：从未扫描或距上次 ≥ intervalHours 则应扫。 */
export function shouldSweep(lastSweepAt: string | null, intervalHours: number, now: Date): boolean {
  if (!lastSweepAt) return true;
  return now.getTime() - new Date(lastSweepAt).getTime() >= intervalHours * 3600_000;
}

function maintenanceTick(): void {
  if (!getMaintenanceEnabled()) return;
  const now = new Date();
  if (!shouldSweep(getMaintenanceLastSweepAt(), getMaintenanceSweepIntervalHours(), now)) return;
  // 先占位 lastSweepAt 防重入（tick 间隔远小于节律）
  setMaintenanceLastSweepAt(now.toISOString());
  const enqueued = runMaintenanceSweep({
    now,
    maxPages: getMaintenanceMaxPagesPerSweep(),
    enqueue: (slug, subjectId) => {
      queue.enqueue('re-enrich', { slug, subjectId }, subjectId);
    },
    log: (msg) => {
      console.log(`[maintenance] ${msg}`);
    },
  });
  if (enqueued > 0) console.log(`[maintenance] swept: enqueued ${enqueued} re-enrich job(s)`);
}

export function registerHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

let cleanupFn: (() => void) | null = null;
let isProcessing = false;

/**
 * Returns true if the error is likely transient and retryable
 * (network timeouts, aborted requests, rate limits).
 */
/** 业务性失败：重试只会重复消耗 token / 重复冲突，永不重试。 */
const NON_RETRYABLE_ERROR_NAMES = new Set([
  'BudgetExceededError',
  'WriterConflictError',
  'AgentCancelled',
  'SubjectError',
]);

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (NON_RETRYABLE_ERROR_NAMES.has(error.name)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('aborted') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('502')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startWorker(pollIntervalMs = 2000): () => void {
  const intervalId = setInterval(async () => {
    // Prevent concurrent job execution — LLM handlers can run for minutes,
    // and parallel git commits would corrupt the vault.
    if (isProcessing) return;

    const job = queue.claim();
    if (!job) return;

    isProcessing = true;

    const handler = handlers.get(job.type);
    if (!handler) {
      queue.fail(job.id, new Error(`No handler registered for job type: ${job.type}`));
      events.emit(job.id, 'job:failed', `No handler registered for job type: ${job.type}`);
      isProcessing = false;
      return;
    }

    const emit = (
      type: string,
      message: string,
      data?: Record<string, unknown>
    ): void => {
      events.emit(job.id, type, message, data);
    };

    // Start heartbeat to extend lease during long-running jobs
    const heartbeatId = setInterval(() => {
      try {
        queue.updateHeartbeat(job.id);
      } catch {
        // If heartbeat fails, the lease will expire and another worker can reclaim
      }
    }, HEARTBEAT_INTERVAL_MS);

    const attempt = job.attemptCount;

    try {
      const result = await handler(job, emit);
      queue.complete(job.id, result);
      events.emit(job.id, 'job:completed', 'Job completed successfully', { result });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorData: Record<string, unknown> = { error: errorMessage };
      if (error && typeof error === 'object') {
        const e = error as Record<string, unknown>;
        if (e.finishReason) errorData.finishReason = e.finishReason;
        if (e.usage) errorData.usage = e.usage;
      }

      if (attempt <= MAX_RETRIES && isRetryableError(error)) {
        // Retry: requeue the SAME job (preserves job ID for SSE tracking)
        const delay = RETRY_DELAY_MS * attempt;
        events.emit(
          job.id,
          'job:retrying',
          `Retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1}) after ${delay}ms...`,
          { attempt, maxRetries: MAX_RETRIES },
        );
        await sleep(delay);
        queue.requeue(job.id);
      } else {
        queue.fail(job.id, error);
        events.emit(job.id, 'job:failed', errorMessage, errorData);
      }
    } finally {
      clearInterval(heartbeatId);
      isProcessing = false;
    }
  }, pollIntervalMs);

  // 维护层低频 tick：到节律即选页入队 re-enrich（不在此跑 LLM/写盘）。
  const maintenanceId = setInterval(() => {
    try {
      maintenanceTick();
    } catch (err) {
      console.error('[maintenance] sweep tick failed', err);
    }
  }, MAINTENANCE_TICK_MS);

  const cleanup = () => {
    clearInterval(intervalId);
    clearInterval(maintenanceId);
    cleanupFn = null;
  };

  cleanupFn = cleanup;
  return cleanup;
}

export function stopWorker(): void {
  if (cleanupFn) {
    cleanupFn();
  }
}
