/**
 * generateTextWithTools 的 onToolCall 透传：fix/curate tool-loop 借此
 * 把每步工具调用转成 job 事件日志。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  stepCountIs: vi.fn(() => 'step-count-is'),
}));

vi.mock('../task-router', () => ({
  resolveTask: vi.fn(() => ({ task: 'fix', logLabel: 'test-model', timeoutMs: 60_000, maxRetries: 0 })),
}));

vi.mock('../provider-factory', () => ({
  getLanguageModel: vi.fn(() => 'fake-model'),
}));

import { generateTextWithTools } from '../provider-registry';

describe('generateTextWithTools — onToolCall 透传', () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
  });

  it('onStepFinish 触发时按 toolCalls 逐个回调 onToolCall', async () => {
    mocks.generateText.mockImplementation(async (opts: { onStepFinish?: (step: unknown) => void }) => {
      opts.onStepFinish?.({
        toolCalls: [
          { toolName: 'wiki_read', input: { slug: 'a' } },
          { toolName: 'wiki_search', input: { query: 'q' } },
        ],
      });
      return { text: 'done' };
    });
    const seen: { tool: string; args: unknown }[] = [];
    await generateTextWithTools('fix', {
      system: 's',
      messages: [],
      tools: {},
      maxSteps: 3,
      onToolCall: (info: { tool: string; args: unknown }) => seen.push(info),
    } as never);
    expect(seen).toEqual([
      { tool: 'wiki_read', args: { slug: 'a' } },
      { tool: 'wiki_search', args: { query: 'q' } },
    ]);
  });

  it('onToolCall 抛错被吞掉，不影响主流程', async () => {
    mocks.generateText.mockImplementation(async (opts: { onStepFinish?: (step: unknown) => void }) => {
      opts.onStepFinish?.({ toolCalls: [{ toolName: 'wiki_read', input: {} }] });
      return { text: 'done' };
    });
    const result = await generateTextWithTools('fix', {
      system: 's',
      messages: [],
      tools: {},
      maxSteps: 3,
      onToolCall: () => { throw new Error('boom'); },
    } as never);
    expect(result.text).toBe('done');
  });

  it('不传 onToolCall 时不挂 onStepFinish（零开销）', async () => {
    mocks.generateText.mockResolvedValue({ text: 'done' });
    await generateTextWithTools('fix', {
      system: 's',
      messages: [],
      tools: {},
      maxSteps: 3,
    } as never);
    expect(mocks.generateText.mock.calls[0][0].onStepFinish).toBeUndefined();
  });
});
