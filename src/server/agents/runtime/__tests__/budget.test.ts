// src/server/agents/runtime/__tests__/budget.test.ts
import { describe, expect, it } from 'vitest';
import { createBudgetTracker, createRunStepTracker, BudgetExceededError } from '../budget';

describe('BudgetTracker（job 级，仅 token）', () => {
  it('累加 token', () => {
    const b = createBudgetTracker({ maxSteps: 3, maxTokensPerJob: 1000, maxParallelSubAgents: 2 });
    b.chargeTokens(100);
    b.chargeTokens(50);
    expect(b.tokensUsed).toBe(150);
  });

  it('超过 maxTokensPerJob 时 assertWithin 抛错', () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 500, maxParallelSubAgents: 1 });
    b.chargeTokens(300);
    b.chargeTokens(300);
    expect(() => b.assertWithin()).toThrow(BudgetExceededError);
    try {
      b.assertWithin();
    } catch (e) {
      expect((e as BudgetExceededError).limit).toBe('maxTokensPerJob');
    }
  });
});

describe('RunStepTracker（单 agent 实例级）', () => {
  it('计步独立：两个 tracker 互不影响', () => {
    const a = createRunStepTracker(5);
    const b = createRunStepTracker(5);
    a.chargeStep();
    a.chargeStep();
    b.chargeStep();
    expect(a.stepCount).toBe(2);
    expect(b.stepCount).toBe(1);
  });

  it('单实例超过 maxSteps 抛 BudgetExceededError', () => {
    const t = createRunStepTracker(2);
    t.chargeStep();
    t.chargeStep();
    expect(() => t.chargeStep()).toThrow(BudgetExceededError);
    try {
      createRunStepTracker(0).chargeStep();
    } catch (e) {
      expect((e as BudgetExceededError).limit).toBe('maxSteps');
    }
  });
});
