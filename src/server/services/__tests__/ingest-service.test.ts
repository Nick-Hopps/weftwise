import { beforeAll, describe, expect, it, vi } from 'vitest';
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
  saveRawSource: vi.fn(() => ({ id: 'web-src-1', contentHash: 'abc' })),
}));

let mockMaxTokens = 100_000;
vi.mock('../../db/repos/settings-repo', () => ({
  getAgentMaxSteps: () => 5,
  getAgentMaxTokensPerJob: () => mockMaxTokens,
  getAgentMaxParallelSubAgents: () => 2,
  getAgentTaskRouterMode: () => 'frontmatter-override',
  getWikiLanguage: () => 'Chinese',
  getAgentAutoCurate: () => false,
}));

vi.mock('../../jobs/queue', () => ({
  enqueue: vi.fn(),
}));

// runPipeline 现在返回内容阶段的 carry（含 plan/subjectSlug/sources/languageDirective），
// 不再自带 commit —— commit 由 service 在 finalize（确定性渲染 index/log + commitPending）阶段完成。
const mockRunPipeline = vi.fn(async () => ({
  plan: { pages: [{ slug: 'a', title: 'A', summary: 'sum a' }] },
  subjectSlug: 'general',
  languageDirective: 'x',
  sources: [{ sourceId: 'src1', filename: 'doc.txt' }],
  writerOutputs: [],
}));
vi.mock('../../agents/runtime/orchestrator', () => ({
  runPipeline: (...args: unknown[]) => mockRunPipeline(...args as []),
  WriterConflictError: class extends Error {},
}));

const mockCommitPending = vi.fn(async (): Promise<IngestResult> => ({
  pagesCreated: ['a', 'index', 'log'],
  pagesUpdated: [],
  linksAdded: 0,
  commitSha: 'sha-1',
}));
vi.mock('../../agents/tools/builtin/commit-changeset', () => ({
  commitPending: (...args: unknown[]) => mockCommitPending(...args as []),
}));

// overlay.readPage 会触碰 fs/vault —— finalize 读现有 index/log 时用，stub 成"不存在"。
vi.mock('../../agents/runtime/overlay-vault', () => ({
  createOverlayVault: () => ({
    readPage: async () => null,
    search: async () => [],
    putEntries: () => {},
    snapshot: () => ({}),
  }),
}));

vi.mock('../../agents/runtime/checkpoint', () => ({
  loadCheckpoint: () => ({
    getChunkSummary: () => undefined,
    putChunkSummary: () => {},
    getPlan: () => undefined,
    putPlan: () => {},
    getWriterPage: () => undefined,
    putWriterPage: () => {},
    getCitedSources: () => [],
    putCitedSources: () => {},
    hasAny: () => false,
    progress: () => ({ plan: false, chunkSummaries: 0, writerPages: 0, totalPages: null }),
    clear: () => {},
  }),
}));

let mockSkillVersion = 6;
vi.mock('../../worker-runtime', () => ({
  getRuntimeRegistries: () => ({
    skillRegistry: { get: (id: string) => ({ id, name: id, description: '', version: mockSkillVersion, tools: [], canDispatch: [], systemPrompt: '' }), list: () => [], degraded: () => [] },
    toolRegistry: { register: vi.fn(), resolve: vi.fn(() => []), get: vi.fn() },
  }),
}));

const handlers = new Map<string, (job: unknown, emit: unknown) => Promise<unknown>>();
vi.mock('../../jobs/worker', () => ({
  registerHandler: (type: string, h: (job: unknown, emit: unknown) => Promise<unknown>) => { handlers.set(type, h); },
}));

vi.mock('../embedding-service', () => ({
  enqueueEmbedIndex: vi.fn(),
}));

vi.mock('../../search/web-search', () => ({
  extractContent: vi.fn(async () => []),
  isWebSearchConfigured: vi.fn(() => false),
  webSearch: vi.fn(async () => []),
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
  beforeAll(async () => {
    await import('../ingest-service');
  });

  it('runs orchestrator pipeline and returns IngestResult', async () => {
    mockCleanText = '这是一段短内容。';
    mockMaxTokens = 100_000;
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
    mockCommitPending.mockClear();
    const emit = vi.fn();
    const result = await handler!(job, emit) as IngestResult;
    expect(result.commitSha).toBe('sha-1');
    expect(mockRunPipeline).toHaveBeenCalled();
    const callArg = (mockRunPipeline.mock.calls[0] as unknown as unknown[])[0] as { steps: unknown[] };
    // 小文件走 inline：planner(sequence) + writer/enricher/verifier(fanout×3) = 4 步（reviewer 已移除）
    expect(callArg.steps).toHaveLength(4);

    // finalize（T2.1）：index/log 由确定性渲染产出（不再走 LLM），再用 commitPending 收口提交
    expect(mockCommitPending).toHaveBeenCalledTimes(1);
    const supplied = (mockCommitPending.mock.calls[0] as unknown as unknown[])[1] as Array<{ path: string; content: string }>;
    expect(supplied.map((e) => e.path).sort()).toEqual([
      'wiki/general/index.md', 'wiki/general/log.md',
    ]);
    const indexEntry = supplied.find((e) => e.path === 'wiki/general/index.md')!;
    // 索引须覆盖「现有页 ∪ 本次 plan 页」的并集（不只本次新页）
    expect(indexEntry.content).toContain('[[a|A]]');
    expect(indexEntry.content).toContain('[[existing-a|Existing A]]');
    const logEntry = supplied.find((e) => e.path === 'wiki/general/log.md')!;
    expect(logEntry.content).toContain('ingested "doc.txt"');
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
    // 小文件：planner(sequence) + writer/enricher(fanout×2) + verifier(verify) = 4 步
    expect(opts.steps.map((s) => s.kind)).toEqual(['sequence', 'fanout', 'fanout', 'verify']);
    expect(opts.initialInput.chunkRefs[0].content).toContain('短内容');
    expect(opts.initialInput.existingPages).toEqual([
      { slug: 'existing-a', title: 'Existing A', summary: 'sum A' },
    ]);
    expect(opts.ctx.chunkStore.size).toBeGreaterThan(0);
  });

  it('大文件插入 map 步且 chunkRefs.content 为空（待摘要回填）', async () => {
    // 50k word（约 60k+ token，远超 25k 阈值走大路径）；预算放宽到 1M 让预检通过，
    // 远高于大路径估算（~2.3× totalTokens），避免 chunker / 估算常数微调时用例无声变语义
    mockCleanText = `${'word '.repeat(50_000)}`;
    mockMaxTokens = 1_000_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await handler(makeJob(), vi.fn());

    const opts = (mockRunPipeline.mock.calls as unknown as Array<[unknown]>)[0][0] as {
      steps: Array<{ kind: string; skillId: string }>;
      initialInput: { chunkRefs: Array<{ content: string }> };
    };
    expect(opts.steps[0]).toMatchObject({ kind: 'map', skillId: 'ingest-chunk-summarizer' });
    // 大文件：map + planner(sequence) + writer/enricher(fanout×2) + verifier(verify) = 5 步
    expect(opts.steps.map((s) => s.kind)).toEqual(['map', 'sequence', 'fanout', 'fanout', 'verify']);
    expect(opts.initialInput.chunkRefs[0].content).toBe('');
  });

  it('流水线不再含 reviewer 步：末步为 verifier fanout（commit 已移出 agent runtime）', async () => {
    mockCleanText = '短内容。';
    mockMaxTokens = 100_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await handler(makeJob(), vi.fn());
    const opts = (mockRunPipeline.mock.calls as unknown as Array<[unknown]>)[0][0] as { steps: Array<Record<string, unknown>> };
    expect(opts.steps.some((s) => s.skillId === 'ingest-reviewer')).toBe(false);
    // ⑨：verifier 步已切换为 verify kind（双段式核查，无 skillId）
    expect(opts.steps[opts.steps.length - 1]).toMatchObject({ kind: 'verify' });
    expect(opts.steps[opts.steps.length - 1]).not.toMatchObject({ skillId: 'ingest-verifier' });
  });

  it('预检超预算：流水线启动前失败且不调 runPipeline', async () => {
    // 40k word：大路径估算（~2.3× totalTokens）远超 100k 预算，预检 fail-fast
    mockCleanText = `${'word '.repeat(40_000)}`;
    mockMaxTokens = 100_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await expect(handler(makeJob(), vi.fn())).rejects.toThrow(/agentMaxTokensPerJob/);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('skill 版本守卫：v1 skill 拒绝启动且不调 runPipeline', async () => {
    mockSkillVersion = 1;
    mockCleanText = '短内容。';
    mockMaxTokens = 100_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await expect(handler(makeJob(), vi.fn())).rejects.toThrow(/requires v2/);
    expect(mockRunPipeline).not.toHaveBeenCalled();
    mockSkillVersion = 6; // 恢复
  });

  it('initialInput 包含非空 languageDirective', async () => {
    mockSkillVersion = 6;
    mockCleanText = '短内容。';
    mockMaxTokens = 100_000;
    mockRunPipeline.mockClear();
    const handler = handlers.get('ingest')!;
    await handler(makeJob(), vi.fn());
    const opts = (mockRunPipeline.mock.calls as unknown as Array<[unknown]>)[0][0] as {
      initialInput: { languageDirective?: string };
    };
    expect(typeof opts.initialInput.languageDirective).toBe('string');
    expect(opts.initialInput.languageDirective!.length).toBeGreaterThan(0);
  });
});
