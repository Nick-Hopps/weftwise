import { describe, it, expect, vi, beforeEach } from 'vitest';

const runAgentLoop = vi.fn();
vi.mock('../agent-loop', () => ({ runAgentLoop: (...a: unknown[]) => runAgentLoop(...a) }));

import { runPageSupplement } from '../supplement-page';

const FM = `---\ntitle: 快速排序\nsummary: 分治排序\ntags: [算法]\n---\n`;
const ORIG_BODY = `## 思想\n分治。\n\n## 复杂度\n平均 O(n log n)。\n`;
const ORIG = `${FM}\n${ORIG_BODY}`;

// input 复刻 orchestrator 注入：draftContent = 原文、existingPages 命中 = update
function makeInput() {
  return { slug: 'quicksort', subjectSlug: 'general', draftContent: ORIG, existingPages: [{ slug: 'quicksort' }] };
}
const ctx = { emit: vi.fn() } as unknown as Parameters<typeof runPageSupplement>[0]['ctx'];
const skill = { id: 'reenrich-supplement' } as unknown as Parameters<typeof runPageSupplement>[0]['skill'];

beforeEach(() => { runAgentLoop.mockReset(); (ctx.emit as ReturnType<typeof vi.fn>).mockReset(); });

describe('runPageSupplement', () => {
  it('护栏通过 → 直接采用补全内容', async () => {
    const good = `${FM}\n## 思想\n分治：按基准把数组切两半，各自递归。这里补一段直觉说明为什么这样能降复杂度。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²)。\n`;
    runAgentLoop.mockResolvedValueOnce({ runId: 'r1', output: { action: 'update', path: 'x', content: good }, tokensUsed: 10, stepCount: 1, cacheHitTokens: 0 });
    const r = await runPageSupplement({ skill, ctx, input: makeInput() });
    const out = r.output as { action: string; path: string; content: string };
    expect(out.content).toBe(good);
    expect(out.path).toBe('wiki/general/quicksort.md');
    expect(out.action).toBe('update');
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  it('首次护栏失败 → 重写一次成功', async () => {
    const bad = `${FM}\n## 思想\n分。\n`; // 缩水 + 删标题
    const good = `${FM}\n## 思想\n分治：按基准切两半递归，补一段直觉说明降复杂度的原因如此这般够长了。\n\n## 复杂度\n平均 O(n log n)，最坏 O(n²)。\n`;
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { content: bad }, tokensUsed: 5, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { content: good }, tokensUsed: 5, stepCount: 1, cacheHitTokens: 0 });
    const r = await runPageSupplement({ skill, ctx, input: makeInput() });
    expect((r.output as { content: string }).content).toBe(good);
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    // 第二次调用带 fidelityViolations 反馈
    const secondInput = runAgentLoop.mock.calls[1][0].input as { fidelityViolations?: string[] };
    expect(Array.isArray(secondInput.fidelityViolations)).toBe(true);
  });

  it('两次都失败 → 回落原文 passthrough + emit warn', async () => {
    const bad = `${FM}\n## 思想\n分。\n`;
    runAgentLoop
      .mockResolvedValueOnce({ runId: 'r1', output: { content: bad }, tokensUsed: 5, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'r2', output: { content: bad }, tokensUsed: 5, stepCount: 1, cacheHitTokens: 0 });
    const r = await runPageSupplement({ skill, ctx, input: makeInput() });
    expect((r.output as { content: string }).content).toBe(ORIG); // 原文
    expect(ctx.emit).toHaveBeenCalledWith('reenrich:supplement-fallback', expect.any(String), expect.any(Object));
  });
});
