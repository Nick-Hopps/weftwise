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

interface Waiter {
  estimated: number;
  resolve: (handle: { estimated: number }) => void;
  reject: (err: Error) => void;
}

/**
 * job 级预算：token 总量（step 防护见 createRunStepTracker，作用域是单 agent 实例）。
 *
 * T1.5：并发 fanout（N 页同时跑）会让所有并发实例在任何一页记账前都通过 assertWithin
 * 闸门，并行度直接击穿 maxTokensPerJob。补预扣机制——`reserve(estimated)` 在实例启动前
 * 占住额度，`settle(handle, actual)` 在实例结束（成功或失败）后释放预留；不变式：
 * 任意时刻 `tokensUsed(已确定消费) + reserved(在飞预留) <= maxTokensPerJob`。
 *
 * settle 的 `actual` 参数目前不会再次写入 tokensUsed——真实消费已经由调用方（agent-loop
 * 的 chargeTokens）计入 tokensUsed，settle 只负责把这笔预留从 reserved 里退回、腾出空间
 * 给排队者。保留 actual 形参是为了让调用方语义清晰（失败/跳过时显式传 0），并为将来
 * 需要在 tracker 内部直接记账的调用方留出口子。
 */
export function createBudgetTracker(budget: AgentBudget): BudgetTracker {
  let tokensUsed = 0;
  let reserved = 0;
  const queue: Waiter[] = [];

  function pump(): void {
    while (queue.length > 0) {
      const head = queue[0];
      if (tokensUsed + reserved + head.estimated <= budget.maxTokensPerJob) {
        queue.shift();
        reserved += head.estimated;
        head.resolve({ estimated: head.estimated });
        continue;
      }
      if (reserved === 0) {
        // 没有其他在飞预留会再释放容量了——这是终态，排队者永远等不到，全部拒绝。
        while (queue.length > 0) {
          const w = queue.shift()!;
          w.reject(new BudgetExceededError('maxTokensPerJob', tokensUsed + w.estimated, budget.maxTokensPerJob));
        }
        return;
      }
      return;
    }
  }

  return {
    chargeTokens(n) { tokensUsed += Math.max(0, n | 0); },
    assertWithin() {
      if (tokensUsed + reserved > budget.maxTokensPerJob) {
        throw new BudgetExceededError('maxTokensPerJob', tokensUsed + reserved, budget.maxTokensPerJob);
      }
    },
    get tokensUsed() { return tokensUsed; },
    reserve(estimated) {
      const amount = Math.max(0, estimated | 0);
      // 即便当下零并发（无其他预留）也放不进总预算——等待也无解，立即拒绝，不排队死等。
      if (tokensUsed + amount > budget.maxTokensPerJob) {
        return Promise.reject(new BudgetExceededError('maxTokensPerJob', tokensUsed + amount, budget.maxTokensPerJob));
      }
      if (tokensUsed + reserved + amount <= budget.maxTokensPerJob) {
        reserved += amount;
        return Promise.resolve({ estimated: amount });
      }
      return new Promise((resolve, reject) => {
        queue.push({ estimated: amount, resolve, reject });
      });
    },
    settle(handle, _actual) {
      reserved = Math.max(0, reserved - handle.estimated);
      pump();
    },
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
