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
  recordUsage: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: mocks.generateObject,
  generateText: mocks.generateText,
  tool: mocks.tool,
  InvalidToolInputError: class extends Error {
    static isInstance(): boolean {
      return false;
    }
  },
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

vi.mock('../../../db/repos/usage-repo', () => ({
  recordUsage: mocks.recordUsage,
}));

import { runAgentLoop } from '../agent-loop';

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

const writerSkill = (): SkillTemplate => ({
  id: 'ingest-planner',
  name: 'Ingest Planner',
  description: 'Plans pages',
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

describe('runAgentLoop 用量记账', () => {
  it('成功生成后以 task/model/inputTokens/outputTokens 调用 recordUsage', async () => {
    mocks.generateObject.mockReset();
    mocks.recordUsage.mockReset();
    mocks.generateObject.mockResolvedValueOnce({
      object: {
        entry: { action: 'create', path: 'wiki/general/x.md', content: '---\ntitle: X\n---\n' },
      },
      usage: { inputTokens: 100, outputTokens: 40 },
    });

    const ctx = ctxStub();
    await runAgentLoop({ skill: writerSkill(), ctx, input: { slug: 'x', subjectSlug: 'general' } });

    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'skill:writer',
      model: 'test-model',
      inputTokens: 100,
      outputTokens: 40,
    });
  });

  it('recordUsage 抛错时 runAgentLoop 仍正常返回 output', async () => {
    mocks.generateObject.mockReset();
    mocks.recordUsage.mockReset();
    mocks.recordUsage.mockImplementationOnce(() => {
      throw new Error('db locked');
    });
    mocks.generateObject.mockResolvedValueOnce({
      object: {
        entry: { action: 'create', path: 'wiki/general/y.md', content: '---\ntitle: Y\n---\n' },
      },
      usage: { inputTokens: 5, outputTokens: 3 },
    });

    const ctx = ctxStub();
    const result = await runAgentLoop({ skill: writerSkill(), ctx, input: { slug: 'y', subjectSlug: 'general' } });

    expect(result.output).toEqual({
      entry: { action: 'create', path: 'wiki/general/y.md', content: '---\ntitle: Y\n---\n' },
    });
  });
});
