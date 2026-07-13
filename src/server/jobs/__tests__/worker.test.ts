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
  complete: vi.fn(),
  fail: vi.fn(),
  requestCancel: vi.fn(),
  requeue: vi.fn(),
  updateHeartbeat: vi.fn(),
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
  getMaintenanceSweepIntervalHours: vi.fn(() => 24),
  getMaintenanceMaxPagesPerSweep: vi.fn(() => 10),
  getMaintenanceLastSweepAt: vi.fn(() => null),
  setMaintenanceLastSweepAt: vi.fn(),
  getIngestConcurrency: vi.fn(() => 1),
}));

import { decideJobFailureAction, registerHandler, startWorker, stopWorker } from '../worker';
import * as queue from '../queue';

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

    expect(queue.complete).toHaveBeenCalledWith(claimed.id, { deliveries: [] });
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
