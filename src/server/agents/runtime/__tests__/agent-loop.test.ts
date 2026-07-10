import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentContext, SkillTemplate } from '../../types';

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  tool: vi.fn((definition) => definition),
  // 可实例化的 InvalidToolInputError 替身：isInstance 走 instanceof，
  // 让组合路径的「finish 入参校验失败」分支在测试里能被识别（带 toolName）。
  InvalidToolInputError: class extends Error {
    toolName?: string;
    toolArgs?: unknown;
    constructor(opts: { toolName?: string; toolArgs?: unknown } = {}) {
      super(`Invalid arguments for tool ${opts.toolName}`);
      this.toolName = opts.toolName;
      this.toolArgs = opts.toolArgs;
    }
    static isInstance(err: unknown): boolean {
      return err instanceof this;
    }
  },
  resolveTask: vi.fn(() => ({
    task: 'skill:writer',
    profileName: 'test',
    provider: { provider: 'ollama', baseURL: 'http://localhost:11434' },
    model: 'test-model',
    logLabel: 'test-model',
    maxTokens: 1000,
    temperature: 0,
    timeoutMs: 30_000,
  })),
  resolveModel: vi.fn(() => ({ id: 'test-model' })),
  getAgentTaskRouterMode: vi.fn(() => 'frontmatter-override'),
}));

vi.mock('ai', () => ({
  generateObject: mocks.generateObject,
  generateText: mocks.generateText,
  tool: mocks.tool,
  InvalidToolInputError: mocks.InvalidToolInputError,
  stepCountIs: (n: number) => ({ stepCount: n }),
}));

vi.mock('../../../llm/task-router', () => ({
  resolveTask: mocks.resolveTask,
}));

vi.mock('../../../llm/provider-registry', () => ({
  resolveModel: mocks.resolveModel,
  withAnthropicStructuredOutputDefault: () => undefined,
}));

vi.mock('../../../db/repos/settings-repo', () => ({
  getAgentTaskRouterMode: mocks.getAgentTaskRouterMode,
}));

import { runAgentLoop, readCacheHitTokens, inputLabel, summarizeGenerationError, repairToolCallArgs, skillTaskKey } from '../agent-loop';
import { BudgetExceededError } from '../budget';

describe('repairToolCallArgs', () => {
  it('剥离合法 JSON 后的尾随字符（DeepSeek 典型多吐一个 }）', () => {
    // 真实复现：模型工具参数在完整 JSON 后多了一个 }
    expect(repairToolCallArgs('{"entries":[{"action":"create","path":"a.md","content":"x"}],"summary":"s"}}'))
      .toBe('{"entries":[{"action":"create","path":"a.md","content":"x"}],"summary":"s"}');
  });
  it('剥离 JSON 前的前导垃圾', () => {
    expect(repairToolCallArgs('oops {"a":1}')).toBe('{"a":1}');
  });
  it('已是干净 JSON 时返回 null（避免无意义重试 / schema 级错误不误修）', () => {
    expect(repairToolCallArgs('{"a":1}')).toBeNull();
  });
  it('完全不含 JSON 时返回 null', () => {
    expect(repairToolCallArgs('garbage')).toBeNull();
  });
  it('提取出的第一个配平块本身非合法 JSON 时返回 null', () => {
    expect(repairToolCallArgs('{not json}')).toBeNull();
  });
});

describe('skillTaskKey', () => {
  it('把 skill id 首个连字符换成冒号得到 <pipeline>:<stage>', () => {
    expect(skillTaskKey('ingest-planner')).toBe('ingest:planner');
    expect(skillTaskKey('ingest-writer')).toBe('ingest:writer');
    expect(skillTaskKey('ingest-verifier-triage')).toBe('ingest:verifier-triage');
    expect(skillTaskKey('ingest-chunk-summarizer')).toBe('ingest:chunk-summarizer');
  });
  it('无连字符 id 原样返回', () => {
    expect(skillTaskKey('planner')).toBe('planner');
  });
});

describe('inputLabel', () => {
  it('从输入取页面/块标识（slug > path > id > key > title）', () => {
    expect(inputLabel({ slug: 'linear-maps', title: 'x' })).toBe('linear-maps');
    expect(inputLabel({ id: 'c12', heading: '' })).toBe('c12');
    expect(inputLabel({ title: 'Only Title' })).toBe('Only Title');
    expect(inputLabel({})).toBeUndefined();
    expect(inputLabel(null)).toBeUndefined();
  });
});

describe('summarizeGenerationError', () => {
  it('提取 finishReason / 原始文本 / zod 校验问题路径', () => {
    const zodErr = { issues: [{ path: ['entry', 'action'], message: 'Invalid enum value' }] };
    const err = Object.assign(new Error('No object generated: response did not match schema.'), {
      finishReason: 'stop',
      text: '{"action":"create","path":"wiki/general/x.md"}', // 缺 entry 包裹
      cause: Object.assign(new Error('Type validation failed'), { cause: zodErr }),
    });
    const s = summarizeGenerationError(err);
    expect(s.finishReason).toBe('stop');
    expect(s.rawText).toContain('"action":"create"');
    expect(s.detail).toContain('entry.action');
    expect(s.detail).toContain('Invalid enum value');
  });
  it('截断超长原始文本到 ~800 字符', () => {
    const s = summarizeGenerationError({ text: 'x'.repeat(2000) });
    expect(s.rawText!.length).toBeLessThanOrEqual(801);
  });
  it('非对象返回空摘要', () => {
    expect(summarizeGenerationError(null)).toEqual({});
  });
});

describe('readCacheHitTokens', () => {
  it('提取 DeepSeek / OpenAI / Anthropic 各自的缓存命中字段', () => {
    expect(readCacheHitTokens({ deepseek: { promptCacheHitTokens: 1856, promptCacheMissTokens: 5 } })).toBe(1856);
    expect(readCacheHitTokens({ openai: { cachedPromptTokens: 1024 } })).toBe(1024);
    expect(readCacheHitTokens({ anthropic: { cacheReadInputTokens: 512 } })).toBe(512);
  });
  it('无缓存元数据时返回 0', () => {
    expect(readCacheHitTokens(undefined)).toBe(0);
    expect(readCacheHitTokens(null)).toBe(0);
    expect(readCacheHitTokens({})).toBe(0);
    expect(readCacheHitTokens({ deepseek: {} })).toBe(0);
  });
});

function ctxStub(): AgentContext {
  return {
    job: { id: 'j' } as AgentContext['job'],
    subject: { id: 's1', slug: 'general' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeTokens: vi.fn(), assertWithin: vi.fn(), tokensUsed: 0, reserve: vi.fn(), settle: vi.fn() },
    overlay: { snapshot: vi.fn(), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() } as unknown as AgentContext['overlay'],
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
    skillRegistry: { get: vi.fn(), list: vi.fn(() => []), degraded: vi.fn(() => []) },
    rootRunId: 'r0',
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    chunkStore: new Map(),
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 2 },
  } as AgentContext;
}

function toolDefStub(name: string): import('../../types').ToolDef {
  return {
    name,
    source: 'builtin',
    description: name,
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    sideEffect: 'none',
    handler: vi.fn(async () => ({})),
  } as unknown as import('../../types').ToolDef;
}

// 无 outputSchema 的 ingest skill → agent-loop 使用 generateText + 只读工具。
const reviewerSkill = (): SkillTemplate => ({
  id: 'ingest-writer',
  name: 'Ingest Reader',
  description: 'Reads related pages',
  version: 1,
  tools: ['wiki.read', 'wiki.search'],
  canDispatch: [],
  systemPrompt: 'Read related pages.',
});

const writerSkill = (): SkillTemplate => ({
  id: 'ingest-writer',
  name: 'Ingest Writer',
  description: 'Writes pages',
  version: 1,
  tools: [],
  canDispatch: [],
  systemPrompt: 'Return the requested entry.',
  outputSchema: z.object({
    entry: z.object({
      action: z.enum(['create', 'update']),
      path: z.string(),
      content: z.string(),
    }),
  }),
});

describe('runAgentLoop structured output recovery', () => {
  // AI SDK 4 `NoObjectGeneratedError` exposes the raw model text on `err.text`
  // (NOT `responseText`). Tests must mock the real property name.
  it('recovers when a generated object field is returned as a JSON string', async () => {
    mocks.generateObject.mockReset();
    mocks.generateObject.mockRejectedValueOnce(Object.assign(
      new Error('No object generated: response did not match schema.'),
      {
        text: JSON.stringify({
          entry: JSON.stringify({
            action: 'create',
            path: 'wiki/general/javascript-fundamentals.md',
            content: '---\ntitle: JavaScript\n---\n',
          }),
        }),
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ));

    const ctx = ctxStub();
    const result = await runAgentLoop({
      skill: writerSkill(),
      ctx,
      input: { slug: 'javascript-fundamentals', subjectSlug: 'general' },
    });

    expect(result.output).toEqual({
      entry: {
        action: 'create',
        path: 'wiki/general/javascript-fundamentals.md',
        content: '---\ntitle: JavaScript\n---\n',
      },
    });
    expect(ctx.budget.chargeTokens).toHaveBeenCalledWith(30);
    expect(ctx.emit).toHaveBeenCalledWith(
      'agent:step',
      'Ingest Writer recovered structured output',
      expect.objectContaining({ kind: 'structured-output-recovery' }),
    );
  });

  // The reported symptom: model wraps valid JSON in a ```json fence, so the AI SDK
  // raises "could not parse the response." The recovery must extract the embedded JSON.
  it('recovers when the model wraps JSON in a markdown code fence', async () => {
    mocks.generateObject.mockReset();
    const innerObject = {
      entry: {
        action: 'create',
        path: 'wiki/general/typescript.md',
        content: '---\ntitle: TypeScript\n---\n',
      },
    };
    mocks.generateObject.mockRejectedValueOnce(Object.assign(
      new Error('No object generated: could not parse the response.'),
      {
        text: 'Here is the entry:\n```json\n' + JSON.stringify(innerObject) + '\n```',
        usage: { inputTokens: 5, outputTokens: 15 },
      },
    ));

    const ctx = ctxStub();
    const result = await runAgentLoop({
      skill: writerSkill(),
      ctx,
      input: { slug: 'typescript', subjectSlug: 'general' },
    });

    expect(result.output).toEqual(innerObject);
    expect(ctx.budget.chargeTokens).toHaveBeenCalledWith(20);
    expect(ctx.emit).toHaveBeenCalledWith(
      'agent:step',
      'Ingest Writer recovered structured output',
      expect.objectContaining({ kind: 'structured-output-recovery' }),
    );
  });
});

describe('runAgentLoop provider tool-name sanitization', () => {
  // Provider APIs (OpenAI / DeepSeek / ...) require tool names to match
  // ^[a-zA-Z0-9_-]{1,64}$. Internal tool names use dots for namespacing
  // (`vault.read`), which the provider rejects with
  // "Invalid 'tools[0].function.name': string does not match pattern."
  it('sanitizes dotted tool names before passing them to generateText', async () => {
    mocks.generateText.mockReset();
    mocks.generateText.mockResolvedValueOnce({
      text: 'done',
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    const ctx = ctxStub();
    (ctx.toolRegistry.resolve as ReturnType<typeof vi.fn>).mockReturnValue([
      toolDefStub('wiki.read'),
      toolDefStub('wiki.search'),
    ]);

    await runAgentLoop({ skill: reviewerSkill(), ctx, input: {} });

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const arg = mocks.generateText.mock.calls[0][0] as { tools: Record<string, unknown> };
    const names = Object.keys(arg.tools);
    expect(names).toEqual(['wiki_read', 'wiki_search']);
    for (const n of names) {
      expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});

describe('runAgentLoop 失败诊断日志', () => {
  it('结构化输出失败时 emit agent:error（skillId/label/finishReason/原始文本）并仍上抛', async () => {
    mocks.generateObject.mockReset();
    mocks.generateObject.mockRejectedValueOnce(Object.assign(
      new Error('No object generated: response did not match schema.'),
      { finishReason: 'stop', text: '{"action":"create"}', usage: { inputTokens: 1, outputTokens: 2 } },
    ));
    const ctx = ctxStub();
    await expect(runAgentLoop({ skill: writerSkill(), ctx, input: { slug: 'linear-maps' } })).rejects.toThrow();
    expect(ctx.emit).toHaveBeenCalledWith(
      'agent:error',
      expect.stringContaining('linear-maps'),
      expect.objectContaining({
        skillId: 'ingest-writer',
        label: 'linear-maps',
        finishReason: 'stop',
        rawText: expect.stringContaining('action'),
      }),
    );
  });
});

describe('runAgentLoop cache-hit telemetry', () => {
  it('把 providerMetadata 的缓存命中透出到 agent:step(final) 与返回值', async () => {
    mocks.generateObject.mockReset();
    mocks.generateObject.mockResolvedValueOnce({
      object: { entry: { action: 'create', path: 'wiki/general/x.md', content: '' } },
      usage: { inputTokens: 1861, outputTokens: 40 },
      providerMetadata: { deepseek: { promptCacheHitTokens: 1856, promptCacheMissTokens: 5 } },
    });
    const ctx = ctxStub();
    const result = await runAgentLoop({ skill: writerSkill(), ctx, input: { slug: 'x', subjectSlug: 'general' } });
    expect(result.cacheHitTokens).toBe(1856);
    expect(ctx.emit).toHaveBeenCalledWith(
      'agent:step',
      expect.stringContaining('final output'),
      expect.objectContaining({ kind: 'final', tokensIn: 1861, cacheHitTokens: 1856 }),
    );
  });
});

describe('runAgentLoop budget propagation', () => {
  // token 防线在 run 开始时由 ctx.budget.assertWithin() 执行；
  // 该异常必须原样冒泡给 orchestrator，不能在 agent-loop 内被吞掉。
  it('propagates BudgetExceededError thrown by assertWithin', async () => {
    const ctx = ctxStub();
    (ctx.budget.assertWithin as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new BudgetExceededError('maxTokensPerJob', 600000, 500000);
    });

    await expect(runAgentLoop({
      skill: writerSkill(),
      ctx,
      input: { slug: 'any', subjectSlug: 'general' },
    })).rejects.toMatchObject({ name: 'BudgetExceededError' });
  });
});

describe('runAgentLoop 组合路径（tools + outputSchema）', () => {
  it('模型调 finish 即返回其入参为结构化输出', async () => {
    mocks.generateText.mockReset();
    mocks.generateObject.mockReset();
    // 模拟 AI SDK：调用注入的 finish.execute 后返回文本/usage
    mocks.generateText.mockImplementationOnce(async (opts: Record<string, unknown>) => {
      const tools = opts.tools as Record<string, { execute: (args: unknown) => Promise<unknown> }>;
      await tools.finish.execute({ title: 'Page', body: 'B' });
      return { text: '', usage: { inputTokens: 5, outputTokens: 7 }, providerMetadata: {} };
    });
    const skill: SkillTemplate = {
      id: 'writer', name: 'Writer', description: '', version: 1,
      tools: ['wiki.read'], canDispatch: [], systemPrompt: 'sys',
      outputSchema: z.object({ title: z.string(), body: z.string() }),
    };
    const ctx = ctxStub();
    (ctx.toolRegistry.resolve as ReturnType<typeof vi.fn>).mockReturnValue([toolDefStub('wiki.read')]);
    const res = await runAgentLoop({ skill, ctx, input: { slug: 'page' } });
    expect(res.output).toEqual({ title: 'Page', body: 'B' });
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});

describe('runAgentLoop 组合路径 finish 入参校验失败重试', () => {
  // 真实复现：claude-opus 经 packyapi 偶发把 finish 工具调用的入参串吐成空，
  // AI SDK 以 {} 校验 writer schema 失败抛 InvalidToolInputError(toolName:'finish')。
  // 该抖动是间歇性的（同 job 多数页正常产出），不应让整个 ingest job 硬失败。
  const combinedWriter = (): SkillTemplate => ({
    id: 'writer', name: 'Writer', description: '', version: 1,
    tools: ['wiki.read'], canDispatch: [], systemPrompt: 'sys',
    outputSchema: z.object({ title: z.string(), body: z.string() }),
  });

  it('finish 入参校验失败时有界重试，下一次成功产出结构化结果', async () => {
    mocks.generateText.mockReset();
    mocks.generateObject.mockReset();
    mocks.generateText
      .mockImplementationOnce(async () => {
        throw new mocks.InvalidToolInputError({ toolName: 'finish', toolArgs: '' });
      })
      .mockImplementationOnce(async (opts: Record<string, unknown>) => {
        const tools = opts.tools as Record<string, { execute: (a: unknown) => Promise<unknown> }>;
        await tools.finish.execute({ title: 'Page', body: 'B' });
        return { text: '', usage: { inputTokens: 5, outputTokens: 7 }, providerMetadata: {} };
      });

    const ctx = ctxStub();
    (ctx.toolRegistry.resolve as ReturnType<typeof vi.fn>).mockReturnValue([toolDefStub('wiki.read')]);

    const res = await runAgentLoop({ skill: combinedWriter(), ctx, input: { slug: 'page' } });
    expect(res.output).toEqual({ title: 'Page', body: 'B' });
    expect(mocks.generateText).toHaveBeenCalledTimes(2);
    expect(ctx.emit).toHaveBeenCalledWith(
      'agent:step',
      expect.stringContaining('retrying'),
      expect.objectContaining({ kind: 'finish-retry', attempt: 1 }),
    );
  });

  it('finish 入参持续校验失败时，重试耗尽（3 次）后上抛', async () => {
    mocks.generateText.mockReset();
    mocks.generateObject.mockReset();
    mocks.generateText.mockImplementation(async () => {
      throw new mocks.InvalidToolInputError({ toolName: 'finish', toolArgs: '' });
    });

    const ctx = ctxStub();
    (ctx.toolRegistry.resolve as ReturnType<typeof vi.fn>).mockReturnValue([toolDefStub('wiki.read')]);

    await expect(runAgentLoop({ skill: combinedWriter(), ctx, input: { slug: 'page' } })).rejects.toThrow();
    expect(mocks.generateText).toHaveBeenCalledTimes(3);
  });
});
