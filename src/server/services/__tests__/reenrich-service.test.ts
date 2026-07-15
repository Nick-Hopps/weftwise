import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../agents/types';
import { countTokens } from '../../sources/source-chunker';
import { estimateIngestCost, estimatePerPageTokens } from '../ingest-prep';

let mockMaxTokens = 3_000_000;
let mockMarkdown = '# Small page\n\nBody.';

vi.mock('../../db/repos/subjects-repo', () => ({
  getById: () => ({
    id: 'subject-1',
    slug: 'general',
    name: 'General',
    description: '',
    augmentationLevel: 'standard',
    createdAt: '',
    updatedAt: '',
  }),
}));

vi.mock('../../db/repos/pages-repo', () => ({
  getPageBySlug: () => ({ slug: 'small-page', title: 'Small page', summary: 'Summary' }),
}));

const mockApplyAfterEnrich = vi.fn();
vi.mock('../../db/repos/maturity-repo', () => ({
  get: () => null,
  applyAfterEnrich: (...args: unknown[]) => mockApplyAfterEnrich(...args),
}));

vi.mock('../../db/repos/profiles-repo', () => ({
  getProfileOrDefault: () => ({
    backgroundSummary: '',
    stylePrefs: { readingLevel: 'intermediate', verbosity: 'balanced', exampleDensity: 'some' },
  }),
}));

vi.mock('../../db/repos/settings-repo', () => ({
  getAgentMaxSteps: () => 50,
  getAgentMaxTokensPerJob: () => mockMaxTokens,
  getAgentMaxParallelSubAgents: () => 5,
  getWikiLanguage: () => 'Chinese',
}));

vi.mock('../../jobs/queue', () => ({
  isCancelRequested: () => false,
}));

const handlers = new Map<string, (job: unknown, emit: unknown) => Promise<unknown>>();
vi.mock('../../jobs/worker', () => ({
  registerHandler: (type: string, handler: (job: unknown, emit: unknown) => Promise<unknown>) => {
    handlers.set(type, handler);
  },
}));

const mockRunPipeline = vi.fn(async () => undefined);
vi.mock('../../agents/runtime/orchestrator', () => ({
  runPipeline: (...args: unknown[]) => mockRunPipeline(...args as []),
}));

vi.mock('../../agents/runtime/overlay-vault', () => ({
  createOverlayVault: () => ({
    readPage: async () => ({ markdown: mockMarkdown }),
    search: async () => [],
    putEntries: () => {},
    snapshot: () => ({}),
  }),
}));

const mockCheckpointClear = vi.fn();
vi.mock('../../agents/runtime/checkpoint', () => ({
  loadCheckpoint: () => ({
    getCitedSources: () => [],
    clear: () => mockCheckpointClear(),
  }),
}));

vi.mock('../../agents/runtime/commit-pending', () => ({
  commitPending: async () => ({
    pagesCreated: [],
    pagesUpdated: ['small-page'],
    linksAdded: 0,
    commitSha: 'sha-1',
  }),
}));

vi.mock('../../worker-runtime', () => ({
  getRuntimeRegistries: () => ({
    skillRegistry: {
      get: (id: string) => ({ id, name: id, description: '', version: 10, tools: [], canDispatch: [], systemPrompt: '' }),
      list: () => [],
      degraded: () => [],
    },
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
  }),
}));

vi.mock('../embedding-service', () => ({
  enqueueEmbedIndex: vi.fn(),
}));

vi.mock('../page-quality-signal', () => ({
  countPageDeterministicFindings: () => 0,
  pageHasStaleSources: () => false,
}));

function makeJob() {
  return {
    id: 'job-1',
    type: 're-enrich',
    status: 'running',
    subjectId: 'subject-1',
    paramsJson: JSON.stringify({ slug: 'small-page', subjectId: 'subject-1' }),
    resultJson: null,
    createdAt: '',
    startedAt: null,
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 1,
  };
}

describe('re-enrich service 预算', () => {
  beforeAll(async () => {
    await import('../reenrich-service');
  });

  beforeEach(() => {
    mockMaxTokens = 3_000_000;
    mockMarkdown = '# Small page\n\nBody.';
    mockRunPipeline.mockClear();
    mockApplyAfterEnrich.mockClear();
    mockCheckpointClear.mockClear();
  });

  it('按页面成本注入阶段预扣，不把完整 job 预算预扣给单页每个阶段', async () => {
    // 模拟真实 supplement → enricher → verify 的连续预算周期。若 service 未注入估算，
    // 回退值会是完整 3M，第二轮将精确复现 `3M + 第一轮 actual` 的伪超限。
    mockRunPipeline.mockImplementationOnce(async (opts: { ctx: AgentContext }) => {
      for (const actual of [20_762, 15_000, 10_000]) {
        const estimated = opts.ctx.estimateFanoutReserve?.(1)
          ?? opts.ctx.budgetSnapshot.maxTokensPerJob;
        const reservation = await opts.ctx.budget.reserve(estimated);
        opts.ctx.budget.chargeTokens(actual);
        opts.ctx.budget.settle(reservation, actual);
      }
    });
    const emit = vi.fn();
    await handlers.get('re-enrich')!(makeJob(), emit);

    const opts = (mockRunPipeline.mock.calls[0] as unknown as [
      { ctx: AgentContext },
    ])[0];
    const pageTokens = countTokens(mockMarkdown);
    const estimatedCost = estimateIngestCost(pageTokens, 1, true);
    const expectedReserve = estimatePerPageTokens(estimatedCost, 1);

    expect(opts.ctx.estimateFanoutReserve?.(1)).toBe(expectedReserve);
    expect(expectedReserve).toBeLessThan(mockMaxTokens);
    expect(emit).toHaveBeenCalledWith(
      'reenrich:budget',
      expect.stringContaining(String(estimatedCost)),
      { slug: 'small-page', pageTokens, estimatedCost },
    );
  });

  it('估算总成本超过 job 预算时在流水线启动前失败', async () => {
    mockMaxTokens = 10_000;

    await expect(handlers.get('re-enrich')!(makeJob(), vi.fn()))
      .rejects.toThrow(/Estimated re-enrich cost.*agentMaxTokensPerJob=10000/);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});
