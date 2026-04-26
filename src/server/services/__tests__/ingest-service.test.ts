import { describe, expect, it, vi } from 'vitest';
import type { IngestResult } from '@/lib/contracts';

vi.mock('../../db/repos/subjects-repo', () => ({
  getById: () => ({ id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' }),
}));
vi.mock('../../sources/parser-registry', () => ({
  parseSourceAsync: async (filename: string) => ({ cleanText: `body of ${filename}`, summary: `summary of ${filename}` }),
  requiresBuffer: () => false,
}));
vi.mock('../../sources/source-store', () => ({
  getRawSourceContent: () => 'raw content',
  getRawSourceBuffer: () => null,
}));
vi.mock('../../db/repos/settings-repo', () => ({
  getAgentMaxSteps: () => 5,
  getAgentMaxTokensPerJob: () => 100_000,
  getAgentMaxParallelSubAgents: () => 2,
  getAgentTaskRouterMode: () => 'frontmatter-override',
}));

const mockRunPipeline = vi.fn(async (): Promise<IngestResult> => ({
  pagesCreated: ['a'],
  pagesUpdated: [],
  linksAdded: 0,
  commitSha: 'sha-1',
}));
vi.mock('../../agents/runtime/orchestrator', () => ({
  runPipeline: (...args: unknown[]) => mockRunPipeline(...args as []),
  WriterConflictError: class extends Error {},
}));

vi.mock('../../worker-runtime', () => ({
  getRuntimeRegistries: () => ({
    skillRegistry: { get: (id: string) => ({ id, name: id, description: '', version: 1, tools: [], canDispatch: [], systemPrompt: '' }), list: () => [], degraded: () => [] },
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
  }),
}));

const handlers = new Map<string, (job: unknown, emit: unknown) => Promise<unknown>>();
vi.mock('../../jobs/worker', () => ({
  registerHandler: (type: string, h: (job: unknown, emit: unknown) => Promise<unknown>) => { handlers.set(type, h); },
}));

describe('ingest-service', () => {
  it('runs orchestrator pipeline and returns IngestResult', async () => {
    await import('../ingest-service');
    const handler = handlers.get('ingest');
    expect(handler).toBeDefined();
    const job = {
      id: 'j1',
      type: 'ingest',
      status: 'running',
      subjectId: 's1',
      paramsJson: JSON.stringify({ sourceId: 'src-1', filename: 'src-1.md', subjectId: 's1' }),
      resultJson: null,
      createdAt: '', startedAt: null, completedAt: null,
      leaseExpiresAt: null, heartbeatAt: null, attemptCount: 0,
    };
    const emit = vi.fn();
    const result = await handler!(job, emit) as IngestResult;
    expect(result.commitSha).toBe('sha-1');
    expect(mockRunPipeline).toHaveBeenCalledOnce();
    const callArg = (mockRunPipeline.mock.calls[0] as unknown as unknown[])[0] as { steps: unknown[] };
    expect(callArg.steps).toHaveLength(3);
  });
});
