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

// 注：settle(handle, actual) 只负责把 handle 对应的预留额度退回 reserved（唤醒排队者）；
// 真实消费仍由调用方在拿到结果后显式 chargeTokens() 记账（与现有 agent-loop 的记账时点
// 一致，settle 不重复计费）。以下用例按「reserve → chargeTokens(真实消费) → settle(释放)」
// 的真实调用顺序编排。
describe('BudgetTracker 预扣（reserve/settle，T1.5）', () => {
  it('任意时刻 spent+reserved 不超过 cap：多个并发 reserve 后仍受总量约束', async () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 1000, maxParallelSubAgents: 5 });
    const h1 = await b.reserve(300);
    const h2 = await b.reserve(300);
    const h3 = await b.reserve(300);
    // 三笔预留共 900，尚未结算，assertWithin 不应抛（900 <= 1000）
    expect(() => b.assertWithin()).not.toThrow();
    // 第四笔 300 会让 spent(0)+reserved(900)+300=1200 超限，必须排队等待，不能立即拿到
    let fourthSettled = false;
    const p4 = b.reserve(300).then((h4) => {
      fourthSettled = true;
      return h4;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fourthSettled).toBe(false);

    // 结算 h1/h2（真实消费均为 0，模拟保守估算下页面实际未耗尽预留），腾出足够空间给第四笔
    b.settle(h1, 0);
    b.settle(h2, 0);
    const h4 = await p4;
    expect(fourthSettled).toBe(true);
    // 全程任意时刻 spent+reserved 都没有超过 cap（reserve()/pump() 内部已保证；这里只再复核一次不变式）
    expect(() => b.assertWithin()).not.toThrow();
    b.chargeTokens(300); // h3 结算
    b.settle(h3, 300);
    b.chargeTokens(300); // h4 结算
    b.settle(h4, 300);
    expect(b.tokensUsed).toBe(600);
  });

  it('预扣排队：额度暂时不足的页在他页 settle 后能继续', async () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 100, maxParallelSubAgents: 2 });
    const h1 = await b.reserve(80);
    let resolved = false;
    const p2 = b.reserve(50).then((h) => {
      resolved = true;
      return h;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    b.chargeTokens(20);
    b.settle(h1, 20); // 释放后 spent=20, reserved=0，50 可以进来
    const h2 = await p2;
    expect(resolved).toBe(true);
    b.chargeTokens(50);
    b.settle(h2, 50);
    expect(b.tokensUsed).toBe(70);
  });

  it('彻底不足（即便无其他在飞预留也放不下）：立即抛 BudgetExceededError', async () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 100, maxParallelSubAgents: 2 });
    b.chargeTokens(90);
    await expect(b.reserve(50)).rejects.toThrow(BudgetExceededError);
  });

  it('彻底不足（排队后所有在飞预留都结算完仍不够）：排队者最终被拒', async () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 100, maxParallelSubAgents: 2 });
    const h1 = await b.reserve(60);
    const waiting = b.reserve(50);
    // h1 结算：实际花费把 spent 顶到 90，剩余容量只有 10，排队的 50 永远不可能进来
    b.chargeTokens(90);
    b.settle(h1, 90);
    await expect(waiting).rejects.toThrow(BudgetExceededError);
  });

  it('失败路径：run 抛错后预留必须被释放（不阻塞后续预扣）', async () => {
    const b = createBudgetTracker({ maxSteps: 100, maxTokensPerJob: 100, maxParallelSubAgents: 2 });
    const h1 = await b.reserve(80);
    try {
      throw new Error('run failed');
    } catch {
      b.settle(h1, 0); // 失败：未产生消费，不 chargeTokens，只释放预留
    }
    const h2 = await b.reserve(80); // 若预留未释放，这里会一直挂起
    b.chargeTokens(80);
    b.settle(h2, 80);
    expect(b.tokensUsed).toBe(80);
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
