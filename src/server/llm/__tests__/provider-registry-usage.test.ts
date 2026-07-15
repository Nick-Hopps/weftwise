import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  streamText: vi.fn(),
  embedMany: vi.fn(),
  recordUsage: vi.fn(),
  resolveTask: vi.fn(() => ({
    task: 'query',
    profileName: 'default',
    provider: { provider: 'anthropic' },
    model: 'test-model',
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
}));

vi.mock('ai', () => ({
  embedMany: mocks.embedMany,
  generateObject: mocks.generateObject,
  generateText: mocks.generateText,
  streamText: mocks.streamText,
  stepCountIs: (n: number) => ({ stepCount: n }),
  NoObjectGeneratedError: class NoObjectGeneratedError extends Error {
    static isInstance(error: unknown): boolean {
      return error instanceof this;
    }

    cause: unknown;
    text: string | undefined;
    finishReason: string | undefined;
    usage: unknown;

    constructor(options: {
      message?: string;
      cause?: unknown;
      text?: string;
      finishReason?: string;
      usage?: unknown;
    }) {
      super(options.message ?? 'No object generated.');
      this.cause = options.cause;
      this.text = options.text;
      this.finishReason = options.finishReason;
      this.usage = options.usage;
    }
  },
}));

vi.mock('../task-router', () => ({ resolveTask: mocks.resolveTask }));

vi.mock('../provider-factory', () => ({
  getLanguageModel: vi.fn(() => ({}) as unknown),
  getEmbeddingModel: vi.fn(() => ({}) as unknown),
}));

vi.mock('../config-loader', () => ({
  getLLMConfig: vi.fn(() => ({ tasks: { embedding: { model: 'embed-model' } } })),
}));

vi.mock('../../db/repos/usage-repo', () => ({ recordUsage: mocks.recordUsage }));

import {
  generateStructuredOutput,
  generateTextWithTools,
  generateEmbeddings,
  streamTextResponse,
  streamTextWithTools,
} from '../provider-registry';
import { NoObjectGeneratedError } from 'ai';
import { z } from 'zod';

beforeEach(() => {
  mocks.generateObject.mockReset();
  mocks.generateText.mockReset();
  mocks.streamText.mockReset();
  mocks.embedMany.mockReset();
  mocks.recordUsage.mockReset();
});

describe('provider-registry usage 记账', () => {
  it('generateStructuredOutput 成功后按 route.task/model 记账', async () => {
    mocks.generateObject.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    await generateStructuredOutput('query', z.object({ ok: z.boolean() }), 'sys', 'user');
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query',
      model: 'test-model',
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it('usage 缺失时仍调用 recordUsage（缺失守卫在 repo 层）且不抛错', async () => {
    mocks.generateObject.mockResolvedValue({ object: { ok: true }, usage: undefined });
    await expect(
      generateStructuredOutput('query', z.object({ ok: z.boolean() }), 'sys', 'user'),
    ).resolves.toEqual({ ok: true });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query',
      model: 'test-model',
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });

  it('recordUsage 抛错不影响返回值', async () => {
    mocks.generateObject.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    mocks.recordUsage.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(
      generateStructuredOutput('query', z.object({ ok: z.boolean() }), 'sys', 'user'),
    ).resolves.toEqual({ ok: true });
  });

  it('generateTextWithTools 优先 totalUsage（多步累计）', async () => {
    mocks.generateText.mockResolvedValue({
      text: 'done',
      usage: { inputTokens: 10, outputTokens: 5 },
      totalUsage: { inputTokens: 100, outputTokens: 50 },
    });
    await generateTextWithTools('query', { system: 's', messages: [], tools: {}, maxSteps: 3 });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query',
      model: 'test-model',
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('LLM 调用失败不记账', async () => {
    mocks.generateObject.mockRejectedValue(new Error('boom'));
    await expect(
      generateStructuredOutput('query', z.object({ ok: z.boolean() }), 'sys', 'user'),
    ).rejects.toThrow('boom');
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('schema 校验失败时按配置重试一次并把字段路径注入重试提示', async () => {
    const schemaError = new NoObjectGeneratedError({
      message: 'No object generated: response did not match schema.',
      cause: {
        cause: {
          issues: [{ path: ['findings', 0, 'evidence'], message: 'Required' }],
        },
      } as Error,
      text: '{"findings":[{}]}',
      response: {} as never,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    });
    mocks.generateObject
      .mockRejectedValueOnce(schemaError)
      .mockResolvedValueOnce({
        object: { ok: true },
        usage: { inputTokens: 20, outputTokens: 8 },
      });

    await expect(
      generateStructuredOutput(
        'query',
        z.object({ ok: z.boolean() }),
        'sys',
        'user',
        {},
        { schemaRetries: 1 },
      ),
    ).resolves.toEqual({ ok: true });

    expect(mocks.generateObject).toHaveBeenCalledTimes(2);
    expect(mocks.generateObject.mock.calls[1][0].system).toContain(
      'findings.0.evidence: Required',
    );
    expect(mocks.generateObject.mock.calls[1][0].prompt).toBe('user');
  });

  it('非结构化输出错误不重试', async () => {
    mocks.generateObject.mockRejectedValue(new Error('network down'));

    await expect(
      generateStructuredOutput(
        'query',
        z.object({ ok: z.boolean() }),
        'sys',
        'user',
        {},
        { schemaRetries: 1 },
      ),
    ).rejects.toThrow('network down');

    expect(mocks.generateObject).toHaveBeenCalledOnce();
  });

  it('generateEmbeddings 把 usage.tokens 记为 inputTokens', async () => {
    mocks.embedMany.mockResolvedValue({ embeddings: [[0.1]], usage: { tokens: 77 } });
    await generateEmbeddings(['hello']);
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query', // resolveTask mock 固定返回 task:'query'
      model: 'test-model',
      inputTokens: 77,
      outputTokens: 0,
    });
  });

  it('streamTextResponse 的 onFinish 触发时记账（totalUsage 优先）', () => {
    mocks.streamText.mockReturnValue({} as unknown);
    streamTextResponse('query', 'sys', 'user');
    // 从传给 streamText 的 options 里取出 onFinish 手动触发，模拟流结束
    const opts = mocks.streamText.mock.calls[0][0] as {
      onFinish: (e: { usage?: unknown; totalUsage?: unknown }) => void;
    };
    opts.onFinish({
      usage: { inputTokens: 1, outputTokens: 1 },
      totalUsage: { inputTokens: 200, outputTokens: 80 },
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query',
      model: 'test-model',
      inputTokens: 200,
      outputTokens: 80,
    });
  });

  it('streamTextWithTools 的 onFinish 无 totalUsage 时回落 usage', () => {
    mocks.streamText.mockReturnValue({} as unknown);
    streamTextWithTools('query', { system: 's', messages: [], tools: {}, maxSteps: 3 });
    const opts = mocks.streamText.mock.calls[0][0] as {
      onFinish: (e: { usage?: unknown; totalUsage?: unknown }) => void;
    };
    opts.onFinish({ usage: { inputTokens: 30, outputTokens: 12 } });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query',
      model: 'test-model',
      inputTokens: 30,
      outputTokens: 12,
    });
  });
});
