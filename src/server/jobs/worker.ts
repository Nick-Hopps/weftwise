import * as queue from './queue';
import * as events from './events';
import type { Job } from '@/lib/contracts';
import { describeErrorMessage } from '@/lib/error-format';
import { runMaintenanceSweep } from '../services/maintenance-scheduler';
import { pruneOldOperations } from '../db/repos/operations-repo';
import { pruneOldUsage, USAGE_RETENTION_MS } from '../db/repos/usage-repo';
import { maintainPendingActions } from '../services/pending-action-maintenance';
import {
  reconcileResearchProvenance,
  reconcileResearchProvenanceForJob,
} from '../services/research-provenance-reconciler';
import {
  getMaintenanceEnabled,
  getMaintenanceSweepIntervalHours,
  getMaintenanceMaxPagesPerSweep,
  getMaintenanceLastSweepAt,
  setMaintenanceLastSweepAt,
  getIngestConcurrency,
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
const OPERATIONS_KEEP_PER_SUBJECT = 500; // operations 每 subject 保留最近 N 条终态行

/**
 * job_events 保留清扫：删除超出保留窗口的事件，止住该表无界增长。
 * 独立于成熟度维护开关（getMaintenanceEnabled，默认关）——基础卫生操作必须始终执行。
 */
function pruneOldJobEvents(): void {
  const cutoff = new Date(Date.now() - JOB_EVENT_RETENTION_MS).toISOString();
  const removed = queue.pruneEvents(cutoff);
  if (removed > 0) console.log(`[maintenance] pruned ${removed} expired job_events`);
}

/**
 * operations 表保留清扫：每 subject 只保留最近 500 条终态（非 pending）行，止住
 * Saga 变更集持久化表随写入无限增长。独立于成熟度维护开关——基础卫生操作必须始终执行。
 * 被清理的 operation 对应的 /history 条目会随之消失（vault git 提交本身不受影响）。
 */
function pruneOldOperationsTick(): void {
  const removed = pruneOldOperations(OPERATIONS_KEEP_PER_SUBJECT);
  if (removed > 0) console.log(`[maintenance] pruned ${removed} expired operations`);
}

/**
 * llm_usage 保留清扫：删除 90 天前的用量明细，止住该表无界增长。
 * 独立于成熟度维护开关——基础卫生操作必须始终执行。
 */
function pruneOldUsageTick(): void {
  const removed = pruneOldUsage(Date.now() - USAGE_RETENTION_MS);
  if (removed > 0) console.log(`[maintenance] pruned ${removed} expired llm_usage rows`);
}

/** 审批操作卫生维护：过期 pending、恢复中断执行，并清理 30 天前终态记录。 */
function maintainPendingActionsTick(): void {
  const { expired, recovered, pruned } = maintainPendingActions();
  if (expired + recovered + pruned > 0) {
    console.log(
      `[maintenance] pending_actions: expired ${expired}, recovered ${recovered}, pruned ${pruned}`,
    );
  }
}

/** 对账异常属于派生状态恢复失败，不能覆盖已经持久化的 job 终态。 */
function reconcileTerminalJob(jobId: string): void {
  try {
    reconcileResearchProvenanceForJob(jobId);
  } catch (error) {
    console.error('[research-provenance] terminal reconcile failed', error);
  }
}

function reconcileResearchTick(): void {
  try {
    reconcileResearchProvenance();
  } catch (error) {
    console.error('[research-provenance] maintenance reconcile failed', error);
  }
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
// 运行中任务表 jobId → type（并发调度依据）
const runningJobs = new Map<string, string>();

/** 供 worker-entry 优雅关停 drain 用：返回当前在飞任务数 */
export function runningJobCount(): number {
  return runningJobs.size;
}

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
  // AI SDK 的 RetryError：reason='maxRetriesExceeded' 说明 SDK 自己判定每次尝试都是
  // 瞬时可重试错误（超时/网络/5xx），只是次数用完；job 级再给一次机会（更长退避）
  // 经常能跨过去。reason='errorNotRetryable' 是遇到了明确的非瞬时错误，重试没有意义。
  if (error.name === 'AI_RetryError') {
    return (error as { reason?: string }).reason === 'maxRetriesExceeded';
  }
  // 部分瞬时网络错误的真实原因在 cause 里而不是 message（如 undici 的 "terminated"），
  // 两处都搜一遍关键字。
  const cause = (error as { cause?: unknown }).cause;
  const causeText = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '';
  const msg = `${error.message} ${causeText}`.toLowerCase();
  return (
    msg.includes('aborted') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated') ||
    msg.includes('other side closed') ||
    msg.includes('failed to process successful response') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('524')
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

async function runJob(job: Job): Promise<void> {
  const handler = handlers.get(job.type);
  if (!handler) {
    queue.fail(job.id, new Error(`No handler registered for job type: ${job.type}`));
    events.emit(job.id, 'job:failed', `No handler registered for job type: ${job.type}`);
    reconcileTerminalJob(job.id);
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
    reconcileTerminalJob(job.id);
  } catch (error) {
    const errorMessage = describeErrorMessage(error);
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
      reconcileTerminalJob(job.id);
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
      reconcileTerminalJob(job.id);
    }
  } finally {
    clearInterval(heartbeatId);
  }
}

export function startWorker(pollIntervalMs = 2000): () => void {
  // 启动即清一次积压（存量库可能已累积大量旧事件/操作记录）。
  try {
    pruneOldJobEvents();
  } catch (err) {
    console.error('[maintenance] job_events prune failed', err);
  }
  reconcileResearchTick();
  try {
    pruneOldOperationsTick();
  } catch (err) {
    console.error('[maintenance] operations prune failed', err);
  }
  try {
    pruneOldUsageTick();
  } catch (err) {
    console.error('[maintenance] llm_usage prune failed', err);
  }
  try {
    maintainPendingActionsTick();
  } catch (err) {
    console.error('[maintenance] pending_actions maintenance failed', err);
  }

  const intervalId = setInterval(() => {
    // 并发调度：仅 ingest 之间可并发（上限实时读设置）；非 ingest 独占。
    // 写入安全由 vault-mutex（进程内队列 + 跨进程文件锁）保证，git commit 排队执行。
    const decision = decideClaim([...runningJobs.values()], getIngestConcurrency());
    if (decision === 'none') return;

    const job = decision === 'ingest-only' ? queue.claim('ingest') : queue.claim();
    if (!job) return;

    runningJobs.set(job.id, job.type);
    void runJob(job).finally(() => {
      runningJobs.delete(job.id);
    });
  }, pollIntervalMs);

  // 维护层低频 tick：清扫过期 job_events（始终执行）+ 到节律选页入队 re-enrich（受开关控制）。
  const maintenanceId = setInterval(() => {
    try {
      pruneOldJobEvents();
    } catch (err) {
      console.error('[maintenance] job_events prune failed', err);
    }
    reconcileResearchTick();
    try {
      pruneOldOperationsTick();
    } catch (err) {
      console.error('[maintenance] operations prune failed', err);
    }
    try {
      pruneOldUsageTick();
    } catch (err) {
      console.error('[maintenance] llm_usage prune failed', err);
    }
    try {
      maintainPendingActionsTick();
    } catch (err) {
      console.error('[maintenance] pending_actions maintenance failed', err);
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
