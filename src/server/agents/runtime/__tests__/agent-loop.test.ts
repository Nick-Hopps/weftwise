import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentContext, SkillTemplate } from '../../types';

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  tool: vi.fn((definition) => definition),
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
}));

vi.mock('../../../llm/task-router', () => ({
  resolveTask: mocks.resolveTask,
}));

vi.mock('../../../llm/provider-registry', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('../../../db/repos/settings-repo', () => ({
  getAgentTaskRouterMode: mocks.getAgentTaskRouterMode,
}));

import { runAgentLoop } from '../agent-loop';
import { BudgetExceededError } from '../budget';

function ctxStub(): AgentContext {
  return {
    job: { id: 'j' } as AgentContext['job'],
    subject: { id: 's1', slug: 'general' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeTokens: vi.fn(), assertWithin: vi.fn(), tokensUsed: 0 },
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

// A reviewer-like skill: no outputSchema → agent-loop uses generateText with tools.
const reviewerSkill = (): SkillTemplate => ({
  id: 'ingest-reviewer',
  name: 'Ingest Reviewer',
  description: 'Reviews and commits',
  version: 1,
  tools: ['vault.read', 'vault.search', 'commit_changeset'],
  canDispatch: [],
  systemPrompt: 'Review the drafts.',
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
        usage: { promptTokens: 10, completionTokens: 20 },
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
        usage: { promptTokens: 5, completionTokens: 15 },
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
  // (`vault.read`, `mcp.<server>.<tool>`), which the provider rejects with
  // "Invalid 'tools[0].function.name': string does not match pattern."
  it('sanitizes dotted tool names before passing them to generateText', async () => {
    mocks.generateText.mockReset();
    mocks.generateText.mockResolvedValueOnce({
      text: 'done',
      usage: { promptTokens: 1, completionTokens: 2 },
    });

    const ctx = ctxStub();
    (ctx.toolRegistry.resolve as ReturnType<typeof vi.fn>).mockReturnValue([
      toolDefStub('vault.read'),
      toolDefStub('vault.search'),
      toolDefStub('commit_changeset'),
    ]);

    await runAgentLoop({ skill: reviewerSkill(), ctx, input: {} });

    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    const arg = mocks.generateText.mock.calls[0][0] as { tools: Record<string, unknown> };
    const names = Object.keys(arg.tools);
    expect(names).toEqual(['vault_read', 'vault_search', 'commit_changeset']);
    for (const n of names) {
      expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
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
