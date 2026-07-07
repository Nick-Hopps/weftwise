import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * generateTextWithTools 的 shouldCancel 轮询行为：curate/fix tool-loop 借此响应
 * job 取消（复用 agents/runtime/agent-loop.ts 的 AgentCancelled，不新建错误类型）。
 * 用 vi.useFakeTimers 避免真实等待 2s 轮询间隔。
 */

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  resolveTask: vi.fn(() => ({
    task: 'curate',
    logLabel: 'test-model',
    timeoutMs: 60_000,
    maxTokens: 1000,
    temperature: 0,
    topP: undefined,
    topK: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
    seed: undefined,
    maxRetries: 0,
    headers: undefined,
    providerOptions: undefined,
  })),
  getLanguageModel: vi.fn(() => ({} as unknown)),
}));

vi.mock('ai', () => ({
  embedMany: vi.fn(),
  generateObject: vi.fn(),
  generateText: mocks.generateText,
  streamText: vi.fn(),
  stepCountIs: (n: number) => ({ stepCount: n }),
}));

vi.mock('../task-router', () => ({
  resolveTask: mocks.resolveTask,
}));

vi.mock('../provider-factory', () => ({
  getLanguageModel: mocks.getLanguageModel,
  getEmbeddingModel: vi.fn(),
}));

import { generateTextWithTools } from '../provider-registry';
import { AgentCancelled } from '../../agents/runtime/agent-loop';

describe('generateTextWithTools — shouldCancel 轮询', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.generateText.mockReset();
    mocks.resolveTask.mockClear();
    mocks.getLanguageModel.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shouldCancel 某次轮询返回 true → abort 请求并抛出 AgentCancelled', async () => {
    let cancelNow = false;
    let capturedSignal: AbortSignal | undefined;

    mocks.generateText.mockImplementation((opts: { abortSignal: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise((_resolve, reject) => {
        opts.abortSignal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = generateTextWithTools('curate', {
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      maxSteps: 5,
      shouldCancel: () => cancelNow,
    });

    // 断言事件断言的失败捕获
    const assertion = expect(promise).rejects.toBeInstanceOf(AgentCancelled);

    // 尚未取消：走完一个轮询周期不应 abort
    await vi.advanceTimersByTimeAsync(2000);
    expect(capturedSignal?.aborted).toBe(false);

    // 现在置为取消，下一个轮询周期应 abort
    cancelNow = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(capturedSignal?.aborted).toBe(true);

    await assertion;
  });

  it('正常完成路径：轮询定时器被清理，不会误 abort 已完成的结果', async () => {
    mocks.generateText.mockResolvedValue({ text: 'ok result' });

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    const result = await generateTextWithTools('curate', {
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      maxSteps: 5,
      shouldCancel: () => false,
    });

    expect(result).toEqual({ text: 'ok result' });
    expect(clearIntervalSpy).toHaveBeenCalled();

    // 定时器已清理，继续推进时间不应产生任何副作用/报错
    await vi.advanceTimersByTimeAsync(10_000);
    clearIntervalSpy.mockRestore();
  });

  it('shouldCancel 恒为 false 时，普通 AbortError（如超时）不会被误判为 AgentCancelled', async () => {
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'AbortError';
    mocks.generateText.mockRejectedValue(timeoutErr);

    const promise = generateTextWithTools('curate', {
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      maxSteps: 5,
      shouldCancel: () => false,
    });

    await expect(promise).rejects.toBe(timeoutErr);
    await expect(promise).rejects.not.toBeInstanceOf(AgentCancelled);
  });

  it('未传 shouldCancel 时不创建轮询定时器', async () => {
    mocks.generateText.mockResolvedValue({ text: 'ok' });
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    const result = await generateTextWithTools('curate', {
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      maxSteps: 5,
    });

    expect(result).toEqual({ text: 'ok' });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});
