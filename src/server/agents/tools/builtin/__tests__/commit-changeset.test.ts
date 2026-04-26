import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../../types';
import { commitChangesetTool } from '../commit-changeset';

vi.mock('../../../../wiki/wiki-transaction', () => ({
  createChangeset: vi.fn((_jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: 'cs-1',
    jobId: _jobId,
    subjectId: subject.id,
    subjectSlug: subject.slug,
    entries,
    preHead: 'pre',
    postHead: null,
    status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [], warnings: [] })),
  applyChangeset: vi.fn(async (changeset: { entries: unknown[] }) => ({
    ...changeset,
    postHead: 'sha-1',
    status: 'applied',
  })),
  rollbackChangeset: vi.fn(async () => undefined),
}));

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    job: { id: 'j1', subjectId: 's1' } as AgentContext['job'],
    subject: { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeStep: vi.fn(), chargeTokens: vi.fn(), assertWithin: vi.fn(), stepCount: 0, tokensUsed: 0 },
    overlay: { readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn(), snapshot: vi.fn() } as unknown as AgentContext['overlay'],
    toolRegistry: { register: vi.fn(), resolve: vi.fn(), get: vi.fn() },
    skillRegistry: { get: vi.fn(), list: vi.fn(), degraded: vi.fn() },
    rootRunId: 'r1',
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 3 },
    ...overrides,
  } as AgentContext;
}

describe('commit-changeset', () => {
  it('commits once, derives commitSha from postHead, classifies pages by action, flips ctx.committed', async () => {
    const ctx = makeCtx();
    const result = await commitChangesetTool.handler({
      entries: [
        { action: 'create', path: 'wiki/general/a.md', content: '---\ntitle: A\n---\n' },
        { action: 'update', path: 'wiki/general/b.md', content: '---\ntitle: B\n---\n' },
      ],
      summary: 'add a, update b',
    }, ctx);
    expect(result.commitSha).toBe('sha-1');
    expect(result.pagesCreated).toEqual(['a']);
    expect(result.pagesUpdated).toEqual(['b']);
    expect(result.linksAdded).toBe(0);
    expect(ctx.committed.value).toBe(true);
  });

  it('throws on second invocation', async () => {
    const ctx = makeCtx({ committed: { value: true } });
    await expect(commitChangesetTool.handler({
      entries: [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      summary: 'a',
    }, ctx)).rejects.toThrow(/already invoked/);
  });

  it('emits ingest:committing with commit metadata', async () => {
    const ctx = makeCtx();
    const emit = ctx.emit as ReturnType<typeof vi.fn>;
    await commitChangesetTool.handler({
      entries: [{ action: 'create', path: 'wiki/general/x.md', content: 'x' }],
      summary: 's',
    }, ctx);
    expect(emit).toHaveBeenCalledWith('ingest:committing', expect.any(String), expect.objectContaining({
      commitSha: 'sha-1',
      pagesCreated: ['x'],
      pagesUpdated: [],
    }));
  });
});
