import { describe, expect, it, vi } from 'vitest';
import { runPipeline, WriterConflictError } from '../orchestrator';
import type { AgentContext, SkillTemplate } from '../../types';

const mockRun = vi.fn();
vi.mock('../agent-loop', () => ({
  runAgentLoop: (opts: { skill: { id: string }; input: unknown }) => mockRun(opts),
  AgentCancelled: class extends Error {},
}));

function ctxStub(): AgentContext {
  return {
    job: { id: 'j' } as AgentContext['job'],
    subject: { slug: 'general' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeStep: vi.fn(), chargeTokens: vi.fn(), assertWithin: vi.fn(), stepCount: 0, tokensUsed: 0 },
    overlay: { snapshot: vi.fn(() => ({ snapshot: () => ({}), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() })), readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn() } as unknown as AgentContext['overlay'],
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

const stubSkill = (id: string): SkillTemplate => ({
  id, name: id, description: '', version: 1, tools: [], canDispatch: [], systemPrompt: '',
});

describe('orchestrator.runPipeline', () => {
  it('runs sequence steps in order, carrying output', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: '1', output: { plan: { pages: [] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: '2', output: { final: 'ok' }, tokensUsed: 0, stepCount: 1 });
    const result = await runPipeline({
      steps: [{ kind: 'sequence', skillId: 'planner' }, { kind: 'sequence', skillId: 'reviewer' }],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: { sources: [] },
    });
    expect(result).toEqual({ final: 'ok' });
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockRun.mock.calls[1][0].input).toEqual({ plan: { pages: [] } });
  });

  it('fans out per-item with parallel cap', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a' }, { slug: 'b' }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w2', output: { entry: { action: 'create', path: 'wiki/general/b.md', content: '' } }, tokensUsed: 0, stepCount: 1 });
    const result = await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: {},
    });
    expect(mockRun).toHaveBeenCalledTimes(3);
    expect(mockRun.mock.calls[1][0].input).toMatchObject({
      slug: 'a',
      subjectSlug: undefined,
      sources: undefined,
      plan: { pages: [{ slug: 'a' }, { slug: 'b' }] },
    });
    const r = result as { writerOutputs?: unknown[] };
    expect(r.writerOutputs).toHaveLength(2);
  });

  it('passes source and subject context into fanout writers', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: {
        sources: [{ filename: 'source.md', fullText: 'source body' }],
        subjectSlug: 'general',
        existingPages: [],
        plan: { pages: [{ slug: 'a', title: 'A' }] },
      }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 });

    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: {},
    });

    expect(mockRun.mock.calls[1][0].input).toMatchObject({
      slug: 'a',
      title: 'A',
      subjectSlug: 'general',
      sources: [{ filename: 'source.md', fullText: 'source body' }],
      existingPages: [],
      plan: { pages: [{ slug: 'a', title: 'A' }] },
    });
  });

  it('throws WriterConflictError on duplicate writer paths', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a' }, { slug: 'a' }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w1', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w2', output: { entry: { action: 'create', path: 'wiki/general/a.md', content: '' } }, tokensUsed: 0, stepCount: 1 });
    await expect(runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx: ctxStub(),
      initialInput: {},
    })).rejects.toThrow(WriterConflictError);
  });
});
