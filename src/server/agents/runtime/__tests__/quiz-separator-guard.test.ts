import { describe, it, expect, vi } from 'vitest';
import { reconcileQuizSeparator } from '../quiz-separator-guard';
import type { AgentRunResult } from '../agent-loop';

const FM = `---\ntitle: 蒙古帝国\n---\n`;

const OK_QUIZ = [
  '> [!quiz] ❓ 自测',
  '> 为什么窝阔台之死会中止蒙古对欧洲的入侵？',
  '>',
  '> ---',
  '>',
  '> 因为新任大汗须由忽里勒台大会选出。',
].join('\n');

const SPOILED_QUIZ = [
  '> [!quiz] 检验理解',
  '> 问：为什么会中止入侵？',
  '> 答：因为新任大汗须由忽里勒台大会选出。',
].join('\n');

function result(content: string, runId = 'run-1'): AgentRunResult {
  return {
    runId,
    output: { action: 'update', path: 'wiki/world-history/mongol-empire.md', content },
    tokensUsed: 10,
    stepCount: 1,
    cacheHitTokens: 0,
  };
}

function contentOf(r: AgentRunResult): string {
  return (r.output as { content: string }).content;
}

describe('reconcileQuizSeparator — 合规产物零回归', () => {
  it('守约产物原样返回，且不触发重写', async () => {
    const first = result(`${FM}\n${OK_QUIZ}\n`);
    const rerun = vi.fn();
    const emit = vi.fn();

    const out = await reconcileQuizSeparator({ first, rerun, emit, slug: 'mongol-empire' });

    expect(out).toBe(first);
    expect(rerun).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('纯问题形态（无答案）不算违规，不触发重写', async () => {
    const first = result(`${FM}\n> [!quiz] ❓ 自测\n> 为什么反向传播要保存中间激活值？\n`);
    const rerun = vi.fn();
    const out = await reconcileQuizSeparator({ first, rerun, emit: vi.fn() });
    expect(out).toBe(first);
    expect(rerun).not.toHaveBeenCalled();
  });

  it('产物无 content 字段时不触发重写（不把结构异常当成 quiz 违规）', async () => {
    const first: AgentRunResult = {
      runId: 'r', output: { action: 'update', path: 'p' }, tokensUsed: 0, stepCount: 0, cacheHitTokens: 0,
    };
    const rerun = vi.fn();
    const out = await reconcileQuizSeparator({ first, rerun, emit: vi.fn() });
    expect(out).toBe(first);
    expect(rerun).not.toHaveBeenCalled();
  });
});

describe('reconcileQuizSeparator — 重写一次', () => {
  it('违规 → 把 violations 拼回输入重写一次；重写合规则采用重写结果', async () => {
    const first = result(`${FM}\n${SPOILED_QUIZ}\n`, 'first');
    const second = result(`${FM}\n${OK_QUIZ}\n`, 'second');
    const rerun = vi.fn().mockResolvedValue(second);
    const emit = vi.fn();

    const out = await reconcileQuizSeparator({ first, rerun, emit, slug: 'mongol-empire' });

    expect(out).toBe(second);
    expect(rerun).toHaveBeenCalledTimes(1);
    const extra = rerun.mock.calls[0][0] as { quizSeparatorViolations: Array<{ reason: string }> };
    expect(extra.quizSeparatorViolations).toHaveLength(1);
    expect(extra.quizSeparatorViolations[0].reason).toBe('missing-separator');
    // 重写成功不该留下 warn 噪音
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('reconcileQuizSeparator — 重写仍违规则确定性修复', () => {
  it('确定性插入分隔符、emit warn，并保留重写结果的其他字段', async () => {
    const first = result(`${FM}\n${SPOILED_QUIZ}\n`, 'first');
    const second = result(`${FM}\n${SPOILED_QUIZ}\n`, 'second');
    const rerun = vi.fn().mockResolvedValue(second);
    const emit = vi.fn();

    const out = await reconcileQuizSeparator({ first, rerun, emit, slug: 'mongol-empire' });

    expect(rerun).toHaveBeenCalledTimes(1);
    expect(out.runId).toBe('second');
    expect(contentOf(out)).toContain('> ---');
    expect(contentOf(out)).toBe(
      `${FM}\n> [!quiz] 检验理解\n> 问：为什么会中止入侵？\n>\n> ---\n>\n> 答：因为新任大汗须由忽里勒台大会选出。\n`,
    );

    expect(emit).toHaveBeenCalledTimes(1);
    const [type, message, data] = emit.mock.calls[0];
    expect(type).toBe('ingest:warn');
    expect(message).toContain('mongol-empire');
    expect((data as { repaired: unknown[] }).repaired).toHaveLength(1);
  });

  it('setext 形态（写了 --- 但缺空行）同样能被兜住', async () => {
    const broken = `${FM}\n> [!quiz] 自测\n> 问：为什么？\n> ---\n> 答：因为忽里勒台。\n`;
    const first = result(broken, 'first');
    const rerun = vi.fn().mockResolvedValue(result(broken, 'second'));
    const emit = vi.fn();

    const out = await reconcileQuizSeparator({ first, rerun, emit, slug: 'x' });

    expect(contentOf(out)).toBe(`${FM}\n> [!quiz] 自测\n> 问：为什么？\n>\n> ---\n>\n> 答：因为忽里勒台。\n`);
    const extra = rerun.mock.calls[0][0] as { quizSeparatorViolations: Array<{ reason: string }> };
    expect(extra.quizSeparatorViolations[0].reason).toBe('setext-separator');
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
