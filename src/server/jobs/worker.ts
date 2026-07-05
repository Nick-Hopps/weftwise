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
const JOB_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000; // job_events 保留 7 天

/**
 * job_events 保留清扫：删除超出保留窗口的事件，止住该表无界增长。
 * 独立于成熟度维护开关（getMaintenanceEnabled，默认关）——基础卫生操作必须始终执行。
 */
function pruneOldJobEvents(): void {
  const cutoff = new Date(Date.now() - JOB_EVENT_RETENTION_MS).toISOString();
  const removed = queue.pruneEvents(cutoff);
  if (removed > 0) console.log(`[maintenance] pruned ${removed} expired job_events`);
}

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

export type JobFailureAction = 'cancelled' | 'retry' | 'fail';

/**
 * 处理器抛错后的归类（纯函数，便于测试）：
 *  - 用户取消（AgentCancelled）优先：即便仍有重试额度也不重试；
 *  - 可识别的临时错误且未超次数 → retry；
 *  - 其余（业务错误 / 不可识别 / 已达上限）→ fail。
 */
export function decideJobFailureAction(
  error: unknown,
  attempt: number,
  maxRetries: number,
): JobFailureAction {
  if (error instanceof Error && error.name === 'AgentCancelled') return 'cancelled';
  if (attempt <= maxRetries && isRetryableError(error)) return 'retry';
  return 'fail';
}

export type ClaimDecision = 'any' | 'ingest-only' | 'none';

/**
 * 并发调度决策（纯函数，便于测试）：
 *  - 完全空闲 → 可 claim 任意类型（claim 到非 ingest 则该 job 独占直到结束）；
 *  - 当前全是 ingest 且数量 < ingestLimit → 只允许再 claim 一个 ingest；
 *  - 其余（有非 ingest 在跑 / ingest 已满额）→ 本轮不 claim。
 * 仅 ingest 之间可并发；写入安全由 vault-mutex（进程内队列 + 跨进程文件锁）保证。
 */
export function decideClaim(
  runningTypes: readonly string[],
  ingestLimit: number,
): ClaimDecision {
  if (runningTypes.length === 0) return 'any';
  if (runningTypes.every((t) => t === 'ingest') && runningTypes.length < ingestLimit) {
    return 'ingest-only';
  }
  return 'none';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startWorker(pollIntervalMs = 2000): () => void {
  // 启动即清一次积压（存量库可能已累积大量旧事件）。
  try {
    pruneOldJobEvents();
  } catch (err) {
    console.error('[maintenance] job_events prune failed', err);
  }

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

      const action = decideJobFailureAction(error, attempt, MAX_RETRIES);
      if (action === 'cancelled') {
        // 用户取消：cancel 路由通常已把 job 落终态(failed)+清检查点；这里幂等兜底
        // （若仍为 running 则 requestCancel 会落终态），并补发 job:cancelled 区别于失败。
        queue.requestCancel(job.id);
        events.emit(job.id, 'job:cancelled', 'Job cancelled by user', { manual: true });
      } else if (action === 'retry') {
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

  // 维护层低频 tick：清扫过期 job_events（始终执行）+ 到节律选页入队 re-enrich（受开关控制）。
  const maintenanceId = setInterval(() => {
    try {
      pruneOldJobEvents();
    } catch (err) {
      console.error('[maintenance] job_events prune failed', err);
    }
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
