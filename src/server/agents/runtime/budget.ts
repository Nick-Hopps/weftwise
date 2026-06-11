// src/server/agents/runtime/budget.ts
import type { AgentBudget, BudgetTracker, RunStepTracker } from '../types';

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

/** job 级预算：只管 token 总量（step 防护见 createRunStepTracker，作用域是单 agent 实例）。 */
export function createBudgetTracker(budget: AgentBudget): BudgetTracker {
  let tokensUsed = 0;
  return {
    chargeTokens(n) { tokensUsed += Math.max(0, n | 0); },
    assertWithin() {
      if (tokensUsed > budget.maxTokensPerJob) {
        throw new BudgetExceededError('maxTokensPerJob', tokensUsed, budget.maxTokensPerJob);
      }
    },
    get tokensUsed() { return tokensUsed; },
  };
}

/** 单 agent 实例的 step 计数器；map/fanout 实例数量是确定性的，不受此限制。 */
export function createRunStepTracker(maxSteps: number): RunStepTracker {
  let stepCount = 0;
  return {
    chargeStep() {
      stepCount += 1;
      // 允许恰好 maxSteps 步，第 maxSteps+1 步抛出（error 中 actual>cap 表示越界的那次尝试）。
      if (stepCount > maxSteps) {
        throw new BudgetExceededError('maxSteps', stepCount, maxSteps);
      }
    },
    get stepCount() { return stepCount; },
  };
}
