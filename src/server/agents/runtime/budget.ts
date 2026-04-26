import type { AgentBudget, BudgetTracker } from '../types';

export class BudgetExceededError extends Error {
  constructor(
    public readonly limit: 'maxSteps' | 'maxTokensPerJob',
    public readonly actual: number,
    public readonly cap: number,
  ) {
    super(`Agent budget exceeded: ${limit}=${actual}/${cap}`);
    this.name = 'BudgetExceededError';
  }
}

export function createBudgetTracker(budget: AgentBudget): BudgetTracker {
  let stepCount = 0;
  let tokensUsed = 0;
  return {
    chargeStep() { stepCount += 1; },
    chargeTokens(n) { tokensUsed += Math.max(0, n | 0); },
    assertWithin() {
      if (stepCount > budget.maxSteps) {
        throw new BudgetExceededError('maxSteps', stepCount, budget.maxSteps);
      }
      if (tokensUsed > budget.maxTokensPerJob) {
        throw new BudgetExceededError('maxTokensPerJob', tokensUsed, budget.maxTokensPerJob);
      }
    },
    get stepCount() { return stepCount; },
    get tokensUsed() { return tokensUsed; },
  };
}
