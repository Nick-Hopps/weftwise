import { describe, it, expect } from 'vitest';
import { decideJobFailureAction } from '../worker';

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
