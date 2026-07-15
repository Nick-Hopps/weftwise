import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const mockMaintainPendingActions = vi.fn();
const mockReconcileResearchProvenance = vi.fn();
const mockReconcileForJob = vi.fn();
const mockPruneOldOperations = vi.fn(() => 0);

vi.mock('@/server/services/pending-action-maintenance', () => ({
  maintainPendingActions: (...args: unknown[]) => mockMaintainPendingActions(...args),
}));
vi.mock('../queue', () => ({
  pruneEvents: vi.fn(() => 0),
  claim: vi.fn(() => null),
  complete: vi.fn(() => true),
  fail: vi.fn(() => true),
  requestCancel: vi.fn(),
  requeue: vi.fn(() => true),
  updateHeartbeat: vi.fn(() => true),
}));
vi.mock('../events', () => ({ emit: vi.fn() }));
vi.mock('@/server/services/maintenance-scheduler', () => ({
  runMaintenanceSweep: vi.fn(() => 0),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  pruneOldOperations: (...args: Parameters<typeof mockPruneOldOperations>) =>
    mockPruneOldOperations(...args),
}));
vi.mock('@/server/services/research-provenance-reconciler', () => ({
  reconcileResearchProvenance: (...args: Parameters<typeof mockReconcileResearchProvenance>) =>
    mockReconcileResearchProvenance(...args),
  reconcileResearchProvenanceForJob: (...args: Parameters<typeof mockReconcileForJob>) =>
    mockReconcileForJob(...args),
}));
vi.mock('@/server/db/repos/usage-repo', () => ({
  pruneOldUsage: vi.fn(() => 0),
  USAGE_RETENTION_MS: 90 * 24 * 60 * 60_000,
}));
vi.mock('@/server/db/repos/settings-repo', () => ({
  getMaintenanceEnabled: vi.fn(() => false),
  getMaintenanceScope: vi.fn(() => ({ mode: 'all' })),
  getMaintenanceSweepIntervalHours: vi.fn(() => 24),
  getMaintenanceMaxPagesPerSweep: vi.fn(() => 10),
  getMaintenanceLastSweepAt: vi.fn(() => null),
  setMaintenanceLastSweepAt: vi.fn(),
  getIngestConcurrency: vi.fn(() => 1),
}));

import { decideJobFailureAction, registerHandler, startWorker, stopWorker } from '../worker';
import * as queue from '../queue';
import * as events from '../events';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function claimedJob(id: string) {
  return {
    id,
    type: 'lint',
    status: 'running',
    subjectId: 's1',
    paramsJson: '{}',
    resultJson: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    startedAt: '2026-07-14T00:00:00.000Z',
    completedAt: null,
    leaseExpiresAt: '2026-07-14T00:02:00.000Z',
    heartbeatAt: '2026-07-14T00:00:00.000Z',
    attemptCount: 1,
  } as const;
}

class AgentCancelled extends Error {
  constructor() {
    super('Agent cancelled');
    this.name = 'AgentCancelled';
  }
}
class BudgetExceededError extends Error {
  constructor() {
    super('budget exceeded');
    this.name = 'BudgetExceededError';
  }
}
class AIRetryError extends Error {
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'AI_RetryError';
    this.reason = reason;
  }
}
class AIAPICallError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AI_APICallError';
    this.cause = cause;
  }
}

describe('decideJobFailureAction', () => {
  it('AgentCancelled → cancelled（即便仍有重试额度也不重试）', () => {
    expect(decideJobFailureAction(new AgentCancelled(), 1, 2)).toBe('cancelled');
  });

  it('可重试错误且未超次数 → retry', () => {
    expect(decideJobFailureAction(new Error('fetch failed'), 1, 2)).toBe('retry');
    expect(decideJobFailureAction(new Error('429 rate limit'), 2, 2)).toBe('retry');
  });

  it('可重试错误但已达上限 → fail', () => {
    expect(decideJobFailureAction(new Error('timeout'), 3, 2)).toBe('fail');
  });

  it('业务错误(BudgetExceededError) → fail，不重试', () => {
    expect(decideJobFailureAction(new BudgetExceededError(), 1, 2)).toBe('fail');
  });

  it('普通(不可识别)错误 → fail', () => {
    expect(decideJobFailureAction(new Error('something broke'), 1, 2)).toBe('fail');
  });

  it('AI_RetryError reason=maxRetriesExceeded → retry（SDK 已判定每次尝试都是瞬时错误，只是次数用完）', () => {
    const err = new AIRetryError('Failed after 3 attempts. Last error: ', 'maxRetriesExceeded');
    expect(decideJobFailureAction(err, 1, 2)).toBe('retry');
  });

  it('AI_RetryError reason=errorNotRetryable → fail（遇到了明确的非瞬时错误）', () => {
    const err = new AIRetryError(
      "Failed after 2 attempts with non-retryable error: 'bad request'",
      'errorNotRetryable'
    );
    expect(decideJobFailureAction(err, 1, 2)).toBe('fail');
  });

  it('中转层网关超时/连接中断类错误 → retry', () => {
    expect(decideJobFailureAction(new Error('bad response status code 524'), 1, 2)).toBe('retry');
    expect(decideJobFailureAction(new Error('Cannot connect to API: other side closed'), 1, 2)).toBe(
      'retry'
    );
    expect(
      decideJobFailureAction(new AIAPICallError('Failed to process successful response'), 1, 2)
    ).toBe('retry');
  });

  it('真实原因藏在 cause 而不是 message 里（如 undici "terminated"）→ retry', () => {
    const err = new AIAPICallError('Failed to process successful response', 'terminated');
    expect(decideJobFailureAction(err, 1, 2)).toBe('retry');
  });
});

describe('startWorker - pending_actions 卫生维护', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockMaintainPendingActions.mockReset().mockReturnValue({
      expired: 0,
      recovered: 0,
      pruned: 0,
    });
    mockReconcileResearchProvenance.mockReset().mockReturnValue(0);
    mockReconcileForJob.mockReset();
    mockPruneOldOperations.mockClear();
  });

  afterEach(() => {
    stopWorker();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('启动立即维护一次，并在 60 秒 tick 再维护一次', () => {
    startWorker(2_000);
    expect(mockMaintainPendingActions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(mockMaintainPendingActions).toHaveBeenCalledTimes(2);
    expect(mockReconcileResearchProvenance).toHaveBeenCalledTimes(2);
  });

  it('启动与维护 tick 均先对账，再清理 operations', () => {
    startWorker(2_000);
    expect(mockReconcileResearchProvenance.mock.invocationCallOrder[0])
      .toBeLessThan(mockPruneOldOperations.mock.invocationCallOrder[0]!);

    vi.advanceTimersByTime(60_000);
    expect(mockReconcileResearchProvenance.mock.invocationCallOrder[1])
      .toBeLessThan(mockPruneOldOperations.mock.invocationCallOrder[1]!);
  });

  it('job 真正 completed 后触发终态对账，对账异常不覆盖 completed', async () => {
    const claimed = {
      id: 'research-import-1', type: 'research-import', status: 'running', subjectId: 's1',
      paramsJson: '{}', resultJson: null, createdAt: '', startedAt: '', completedAt: null,
      leaseExpiresAt: null, heartbeatAt: null, attemptCount: 1,
    } as const;
    vi.mocked(queue.claim).mockReturnValueOnce(claimed).mockReturnValue(null);
    registerHandler('research-import', async () => ({ deliveries: [] }));
    mockReconcileForJob.mockImplementation(() => { throw new Error('reconcile failed'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startWorker(10);

    await vi.advanceTimersByTimeAsync(10);

    expect(queue.complete).toHaveBeenCalledWith(claimed.id, { deliveries: [] }, 1);
    expect(mockReconcileForJob).toHaveBeenCalledWith(claimed.id);
    expect(queue.fail).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[research-provenance] terminal reconcile failed',
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('维护异常仅记录错误，不中止 worker 后续 tick', () => {
    const error = new Error('db busy');
    mockMaintainPendingActions.mockImplementation(() => { throw error; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    startWorker(2_000);
    vi.advanceTimersByTime(60_000);

    expect(mockMaintainPendingActions).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      '[maintenance] pending_actions maintenance failed',
      error,
    );
  });
});

describe('startWorker - 运行中任务心跳', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockMaintainPendingActions.mockReturnValue({ expired: 0, recovered: 0, pruned: 0 });
    mockReconcileResearchProvenance.mockReturnValue(0);
    mockPruneOldOperations.mockReturnValue(0);
  });

  afterEach(() => {
    stopWorker();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('领取后恰好 30 秒首次续租，长任务持续续租，完成后立即停止', async () => {
    const job = claimedJob('heartbeat-success');
    const result = deferred<Record<string, unknown>>();
    vi.mocked(queue.claim).mockReturnValueOnce(job).mockReturnValue(null);
    registerHandler('lint', () => result.promise);

    startWorker(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.updateHeartbeat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(queue.updateHeartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.updateHeartbeat).toHaveBeenCalledTimes(1);
    expect(queue.updateHeartbeat).toHaveBeenLastCalledWith(job.id, 1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.updateHeartbeat).toHaveBeenCalledTimes(3);

    result.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.complete).toHaveBeenCalledWith(job.id, { ok: true }, 1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.updateHeartbeat).toHaveBeenCalledTimes(3);
  });

  it('handler 失败离开 runJob 后清理心跳定时器', async () => {
    const job = claimedJob('heartbeat-failure');
    vi.mocked(queue.claim).mockReturnValueOnce(job).mockReturnValue(null);
    registerHandler('lint', async () => {
      throw new Error('business failure');
    });

    startWorker(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.fail).toHaveBeenCalledWith(job.id, expect.any(Error), 1);
    expect(events.emit).toHaveBeenCalledWith(
      job.id,
      'job:failed',
      'business failure',
      { error: 'business failure' },
    );
    expect(vi.mocked(queue.fail).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(events.emit).mock.invocationCallOrder[0]!);
    expect(mockReconcileForJob.mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(events.emit).mock.invocationCallOrder[0]!);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.updateHeartbeat).not.toHaveBeenCalled();
  });

  it('最终 fail fencing 未命中时不发布虚假终态事件或触发对账', async () => {
    const job = claimedJob('stale-failure');
    vi.mocked(queue.claim).mockReturnValueOnce(job).mockReturnValue(null);
    vi.mocked(queue.fail).mockReturnValueOnce(false);
    registerHandler('lint', async () => {
      throw new Error('stale saga failure');
    });

    startWorker(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.fail).toHaveBeenCalledWith(job.id, expect.any(Error), 1);
    expect(events.emit).not.toHaveBeenCalledWith(
      job.id,
      'job:failed',
      expect.anything(),
      expect.anything(),
    );
    expect(mockReconcileForJob).not.toHaveBeenCalled();
  });

  it('可重试失败完成 requeue 后清理心跳定时器', async () => {
    const job = claimedJob('heartbeat-retry');
    vi.mocked(queue.claim).mockReturnValueOnce(job).mockReturnValue(null);
    registerHandler('lint', async () => {
      throw new Error('fetch failed');
    });

    startWorker(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.requeue).not.toHaveBeenCalled();
    expect(queue.updateHeartbeat).toHaveBeenCalledTimes(1);
    expect(events.emit).not.toHaveBeenCalledWith(
      job.id,
      'job:retrying',
      expect.anything(),
      expect.anything(),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queue.requeue).toHaveBeenCalledWith(job.id, 1);
    expect(events.emit).toHaveBeenCalledWith(
      job.id,
      'job:retrying',
      expect.any(String),
      { attempt: 1, maxRetries: 2 },
    );
    expect(vi.mocked(queue.requeue).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(events.emit).mock.invocationCallOrder[0]!);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.updateHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('retry requeue fencing 未命中时不发布 job:retrying', async () => {
    const job = claimedJob('stale-retry');
    vi.mocked(queue.claim).mockReturnValueOnce(job).mockReturnValue(null);
    vi.mocked(queue.requeue).mockReturnValueOnce(false);
    registerHandler('lint', async () => {
      throw new Error('fetch failed');
    });

    startWorker(10);
    await vi.advanceTimersByTimeAsync(5_010);

    expect(queue.requeue).toHaveBeenCalledWith(job.id, 1);
    expect(events.emit).not.toHaveBeenCalledWith(
      job.id,
      'job:retrying',
      expect.anything(),
      expect.anything(),
    );
  });

  it('取消 CAS 已终态时不发布 job:cancelled 或重复对账', async () => {
    const job = claimedJob('late-cancel');
    vi.mocked(queue.claim).mockReturnValueOnce(job).mockReturnValue(null);
    vi.mocked(queue.requestCancel).mockReturnValueOnce('already-terminal');
    registerHandler('lint', async () => {
      throw new AgentCancelled();
    });

    startWorker(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.requestCancel).toHaveBeenCalledWith(job.id);
    expect(events.emit).not.toHaveBeenCalledWith(
      job.id,
      'job:cancelled',
      expect.anything(),
      expect.anything(),
    );
    expect(mockReconcileForJob).not.toHaveBeenCalled();
  });

  it('取消 CAS 成功后才发布 job:cancelled 并触发对账', async () => {
    const job = claimedJob('cancelled');
    vi.mocked(queue.claim).mockReturnValueOnce(job).mockReturnValue(null);
    vi.mocked(queue.requestCancel).mockReturnValueOnce('cancelled');
    registerHandler('lint', async () => {
      throw new AgentCancelled();
    });

    startWorker(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(events.emit).toHaveBeenCalledWith(
      job.id,
      'job:cancelled',
      'Job cancelled by user',
      { manual: true },
    );
    expect(vi.mocked(queue.requestCancel).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(events.emit).mock.invocationCallOrder[0]!);
    expect(mockReconcileForJob.mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(events.emit).mock.invocationCallOrder[0]!);
  });

  it('心跳异常被吞掉，不覆盖 handler 的成功结果', async () => {
    const job = claimedJob('heartbeat-error');
    const result = deferred<Record<string, unknown>>();
    vi.mocked(queue.claim).mockReturnValueOnce(job).mockReturnValue(null);
    vi.mocked(queue.updateHeartbeat).mockImplementationOnce(() => {
      throw new Error('db busy');
    });
    registerHandler('lint', () => result.promise);

    startWorker(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queue.updateHeartbeat).toHaveBeenCalledTimes(1);

    result.resolve({ persisted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.complete).toHaveBeenCalledWith(job.id, { persisted: true }, 1);
    expect(queue.fail).not.toHaveBeenCalled();
  });
});
