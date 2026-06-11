import { describe, expect, it, vi } from 'vitest';
import type { IngestResult } from '@/lib/contracts';

vi.mock('../../db/repos/subjects-repo', () => ({
  getById: () => ({ id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' }),
}));

vi.mock('../../db/repos/pages-repo', () => ({
  getAllPages: () => [
    { slug: 'existing-a', title: 'Existing A', summary: 'sum A' },
  ],
}));

let mockCleanText = '这是一段短内容。';
vi.mock('../../sources/parser-registry', () => ({
  parseSourceAsync: async () => ({ title: 't', cleanText: mockCleanText, metadata: {} }),
  requiresBuffer: () => false,
}));

vi.mock('../../sources/source-store', () => ({
  getRawSourceContent: () => 'raw content',
  getRawSourceBuffer: () => null,
  updateSourceChunks: vi.fn(),
}));

let mockMaxTokens = 100_000;
vi.mock('../../db/repos/settings-repo', () => ({
  getAgentMaxSteps: () => 5,
  getAgentMaxTokensPerJob: () => mockMaxTokens,
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

function makeJob() {
  return {
    id: 'j1',
    type: 'ingest',
    status: 'running',
    subjectId: 's1',
    paramsJson: JSON.stringify({ sourceId: 'src1', filename: 'doc.txt', subjectId: 's1' }),
    resultJson: null,
    createdAt: '', startedAt: null, completedAt: null,
    leaseExpiresAt: null, heartbeatAt: null, attemptCount: 0,
  };
}

describe('ingest-service', () => {
  it('runs orchestrator pipeline and returns IngestResult', async () => {
    mockCleanText = '这是一段短内容。';
    mockMaxTokens = 100_000;
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
    expect(mockRunPipeline).toHaveBeenCalled();
    const callArg = (mockRunPipeline.mock.calls[0] as unknown as unknown[])[0] as { steps: unknown[] };
    // 小文件走 inline：sequence + fanout + sequence = 3 步
    expect(callArg.steps).toHaveLength(3);
  });

  it('小文件走 inline：无 map 步，chunkRefs.content 已填全文，existingPages 实读', async () => {
    mockCleanText = '这是一段短内容。';
    mockMaxTokens = 100_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await handler(makeJob(), vi.fn());

    const opts = (mockRunPipeline.mock.calls as unknown as Array<[unknown]>)[0][0] as {
      steps: Array<{ kind: string; skillId: string }>;
      initialInput: { chunkRefs: Array<{ content: string }>; existingPages: unknown[]; outline: string };
      ctx: { chunkStore: Map<string, unknown> };
    };
    expect(opts.steps.map((s) => s.kind)).toEqual(['sequence', 'fanout', 'sequence']);
    expect(opts.initialInput.chunkRefs[0].content).toContain('短内容');
    expect(opts.initialInput.existingPages).toEqual([
      { slug: 'existing-a', title: 'Existing A', summary: 'sum A' },
    ]);
    expect(opts.ctx.chunkStore.size).toBeGreaterThan(0);
  });

  it('大文件插入 map 步且 chunkRefs.content 为空（待摘要回填）', async () => {
    // 50k word（约 60k+ token，远超 25k 阈值走大路径）；预算放宽到 200k 让预检通过，
    // 避免文本量贴着阈值——chunker 参数微调时用例不会无声变语义
    mockCleanText = `${'word '.repeat(50_000)}`;
    mockMaxTokens = 200_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await handler(makeJob(), vi.fn());

    const opts = (mockRunPipeline.mock.calls as unknown as Array<[unknown]>)[0][0] as {
      steps: Array<{ kind: string; skillId: string }>;
      initialInput: { chunkRefs: Array<{ content: string }> };
    };
    expect(opts.steps[0]).toMatchObject({ kind: 'map', skillId: 'ingest-chunk-summarizer' });
    expect(opts.steps.map((s) => s.kind)).toEqual(['map', 'sequence', 'fanout', 'sequence']);
    expect(opts.initialInput.chunkRefs[0].content).toBe('');
  });

  it('reviewer 步声明 omitFromInput 剔除 chunkRefs 与 outline', async () => {
    mockCleanText = '短内容。';
    mockMaxTokens = 100_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await handler(makeJob(), vi.fn());
    const opts = (mockRunPipeline.mock.calls as unknown as Array<[unknown]>)[0][0] as { steps: Array<Record<string, unknown>> };
    const reviewer = opts.steps[opts.steps.length - 1];
    expect(reviewer).toMatchObject({
      kind: 'sequence',
      skillId: 'ingest-reviewer',
      omitFromInput: ['chunkRefs', 'outline'],
    });
  });

  it('预检超预算：流水线启动前失败且不调 runPipeline', async () => {
    // 40k word：估算约 126k > 100k 预算，预检 fail-fast
    mockCleanText = `${'word '.repeat(40_000)}`;
    mockMaxTokens = 100_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await expect(handler(makeJob(), vi.fn())).rejects.toThrow(/agentMaxTokensPerJob/);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});
