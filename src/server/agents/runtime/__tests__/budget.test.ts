import { describe, expect, it } from 'vitest';
import { createBudgetTracker, BudgetExceededError } from '../budget';

describe('BudgetTracker', () => {
  it('counts steps and tokens', () => {
    const b = createBudgetTracker({ maxSteps: 3, maxTokensPerJob: 1000, maxParallelSubAgents: 2 });
    b.chargeStep();
    b.chargeTokens(100);
    expect(b.stepCount).toBe(1);
    expect(b.tokensUsed).toBe(100);
  });

  it('throws BudgetExceededError after maxSteps', () => {
    const b = createBudgetTracker({ maxSteps: 2, maxTokensPerJob: 1_000_000, maxParallelSubAgents: 1 });
    b.chargeStep();
    b.chargeStep();
    b.assertWithin();
    b.chargeStep();
    expect(() => b.assertWithin()).toThrow(BudgetExceededError);
    try {
      b.assertWithin();
    } catch (e) {
      expect((e as BudgetExceededError).limit).toBe('maxSteps');
      expect((e as BudgetExceededError).actual).toBe(3);
    }
  });

  it('throws BudgetExceededError after maxTokensPerJob', () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 500, maxParallelSubAgents: 1 });
    b.chargeTokens(300);
    b.chargeTokens(300);
    expect(() => b.assertWithin()).toThrow(BudgetExceededError);
  });
});
