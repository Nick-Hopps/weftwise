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

function ctxStub(): AgentContext {
  return {
    job: { id: 'j' } as AgentContext['job'],
    subject: { id: 's1', slug: 'general' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeStep: vi.fn(), chargeTokens: vi.fn(), assertWithin: vi.fn(), stepCount: 0, tokensUsed: 0 },
    overlay: { snapshot: vi.fn(), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() } as unknown as AgentContext['overlay'],
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
    skillRegistry: { get: vi.fn(), list: vi.fn(() => []), degraded: vi.fn(() => []) },
    rootRunId: 'r0',
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 2 },
  } as AgentContext;
}

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
  it('recovers when a generated object field is returned as a JSON string', async () => {
    mocks.generateObject.mockReset();
    mocks.generateObject.mockRejectedValueOnce(Object.assign(
      new Error('No object generated: response did not match schema.'),
      {
        responseText: JSON.stringify({
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
});
