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
});
