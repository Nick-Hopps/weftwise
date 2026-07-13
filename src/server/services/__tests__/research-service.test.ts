import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job, LintFinding, RemediationContext } from '@/lib/contracts';

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));

const queueMock = vi.hoisted(() => ({
  get: vi.fn(() => null as Job | null),
  list: vi.fn(() => [] as Job[]),
}));
vi.mock('@/server/jobs/queue', () => queueMock);

vi.mock('@/server/db/repos/subjects-repo', () => ({
  getById: vi.fn(() => ({ id: 's1', slug: 'general', name: 'G', description: '' })),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

const searchMock = vi.hoisted(() => ({
  isWebSearchConfigured: vi.fn(() => true),
  webSearch: vi.fn(async () => [] as Array<{ title: string; url: string; snippet: string }>),
}));
vi.mock('@/server/search/web-search', () => searchMock);

const genMock = vi.hoisted(() => ({ generateStructuredOutput: vi.fn() }));
vi.mock('@/server/llm/provider-registry', () => genMock);

import { findingId } from '../finding-identity';
import { runResearchJob } from '../research-service';
import {
  ResearchScopeError,
  resolveTopicsFromFindingIds,
} from '../research-scope';

const RAW_FINDINGS = [
  {
    type: 'broken-link',
    severity: 'warning',
    pageSlug: 'broken',
    description: 'irrelevant',
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
  },
  {
    type: 'coverage-gap',
    severity: 'info',
    pageSlug: 'grpc-streaming',
    description: 'gRPC streaming',
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
  },
  {
    type: 'coverage-gap',
    severity: 'info',
    pageSlug: 'grpc-streaming-advanced',
    description: 'gRPC streaming',
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
  },
  {
    type: 'coverage-gap',
    severity: 'info',
    pageSlug: 'backpressure',
    description: 'Reactive backpressure',
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
  },
  {
    type: 'thin-page',
    severity: 'info',
    pageSlug: 'thin-without-sources',
    description: 'Thin page without sources',
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
  },
] satisfies Array<LintFinding & { subjectId: string; subjectSlug: string }>;

const BROKEN_ID = findingId(RAW_FINDINGS[0]);
const GAP_ID = findingId(RAW_FINDINGS[1]);
const DUPLICATE_TOPIC_GAP_ID = findingId(RAW_FINDINGS[2]);
const SECOND_GAP_ID = findingId(RAW_FINDINGS[3]);
const THIN_PAGE_ID = findingId(RAW_FINDINGS[4]);
const TOO_MANY_FINDING_IDS = Array.from(
  { length: 101 },
  (_, index) => index.toString(16).padStart(64, '0'),
);

function researchJob(
  params: unknown,
  overrides: Partial<Job> = {},
): Job {
  return {
    id: 'research-1',
    type: 'research',
    status: 'running',
    subjectId: 's1',
    paramsJson: JSON.stringify(params),
    resultJson: null,
    createdAt: '2026-07-12T10:01:00.000Z',
    startedAt: '2026-07-12T10:01:00.000Z',
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

function lintJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'lint-1',
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    paramsJson: JSON.stringify({ subjectId: 's1' }),
    resultJson: JSON.stringify({ findings: RAW_FINDINGS }),
    createdAt: '2026-07-12T10:00:00.000Z',
    startedAt: '2026-07-12T10:00:00.000Z',
    completedAt: '2026-07-12T10:00:30.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

function remediationContext(
  findingIds: string[] = [GAP_ID],
  overrides: Partial<RemediationContext> = {},
): RemediationContext {
  return {
    lintJobId: 'lint-1',
    findingIds,
    action: 'research',
    ...overrides,
  };
}

describe('resolveTopicsFromFindingIds', () => {
  beforeEach(() => {
    queueMock.get.mockReset();
    queueMock.get.mockReturnValue(lintJob());
  });

  it('只从指定 lint 快照按快照顺序解析 coverage-gap，并去重主题', () => {
    expect(resolveTopicsFromFindingIds(
      's1',
      'lint-1',
      [SECOND_GAP_ID, GAP_ID, DUPLICATE_TOPIC_GAP_ID, GAP_ID],
    )).toEqual(['gRPC streaming', 'Reactive backpressure']);
    expect(queueMock.get).toHaveBeenCalledWith('lint-1');
  });

  it('允许单独解析 thin-page finding', () => {
    expect(resolveTopicsFromFindingIds('s1', 'lint-1', [THIN_PAGE_ID]))
      .toEqual(['Thin page without sources']);
  });

  it('coverage-gap 与 thin-page 可在同一批次按快照顺序解析', () => {
    expect(resolveTopicsFromFindingIds('s1', 'lint-1', [THIN_PAGE_ID, GAP_ID]))
      .toEqual(['gRPC streaming', 'Thin page without sources']);
  });

  it.each([
    ['不存在', null],
    ['类型错误', lintJob({ type: 'fix' })],
    ['状态错误', lintJob({ status: 'running' })],
    ['subject 错误', lintJob({ subjectId: 's2' })],
  ] as const)('lint job %s 时拒绝', (_label, storedJob) => {
    queueMock.get.mockReturnValue(storedJob);
    const call = () => resolveTopicsFromFindingIds('s1', 'lint-1', [GAP_ID]);
    expect(call).toThrow(ResearchScopeError);
    expect(call).toThrow(/missing|another subject/);
  });

  it('快照 jobId 与请求 lintJobId 不一致时拒绝', () => {
    queueMock.get.mockReturnValue(lintJob({ id: 'lint-other' }));
    expect(() => resolveTopicsFromFindingIds('s1', 'lint-1', [GAP_ID]))
      .toThrow(/snapshot mismatch/);
  });

  it('任一 finding ID 缺失时拒绝整个请求', () => {
    expect(() => resolveTopicsFromFindingIds('s1', 'lint-1', [GAP_ID, 'f'.repeat(64)]))
      .toThrow(/coverage-gap or thin-page/);
  });

  it('任一 finding 不是 coverage-gap 或 thin-page 时拒绝整个请求', () => {
    expect(() => resolveTopicsFromFindingIds('s1', 'lint-1', [GAP_ID, BROKEN_ID]))
      .toThrow(/coverage-gap or thin-page/);
  });

  it('queue.get 未知异常保持原异常，不包装为范围错误', () => {
    const repositoryError = new Error('database unavailable');
    queueMock.get.mockImplementation(() => {
      throw repositoryError;
    });

    try {
      resolveTopicsFromFindingIds('s1', 'lint-1', [GAP_ID]);
      throw new Error('expected resolver to throw');
    } catch (error) {
      expect(error).toBe(repositoryError);
      expect(error).not.toBeInstanceOf(ResearchScopeError);
    }
  });
});

describe('runResearchJob', () => {
  beforeEach(() => {
    genMock.generateStructuredOutput.mockReset();
    searchMock.webSearch.mockReset();
    searchMock.webSearch.mockResolvedValue([]);
    queueMock.get.mockReset();
    queueMock.get.mockReturnValue(lintJob());
    queueMock.list.mockReset();
    queueMock.list.mockReturnValue([]);
  });

  it('manual topic：三阶段成功 → 返回 triage 过滤后的候选', async () => {
    genMock.generateStructuredOutput
      .mockResolvedValueOnce({ queries: ['rust async runtimes'] })
      .mockResolvedValueOnce({
        results: [
          { url: 'https://a.com', score: 3, reason: 'great' },
          { url: 'https://b.com', score: 1, reason: 'weak' },
        ],
      });
    searchMock.webSearch.mockResolvedValueOnce([
      { title: 'A', url: 'https://a.com', snippet: 'a' },
      { title: 'B', url: 'https://b.com', snippet: 'b' },
    ]);

    const emit = vi.fn();
    const result = await runResearchJob(researchJob({ topic: '  Rust async runtimes  ', subjectId: 's1' }), emit);

    expect(result.candidates).toEqual([
      { url: 'https://a.com', title: 'A', snippet: 'a', score: 3, reason: 'great' },
    ]);
    expect(result.topics).toEqual(['Rust async runtimes']);
    expect(emit).toHaveBeenCalledWith('research:complete', expect.any(String), expect.any(Object));
  });

  it('findingIds 分支使用指定快照并接受一致的规范化处置上下文', async () => {
    genMock.generateStructuredOutput.mockResolvedValueOnce({ queries: ['grpc streaming'] });
    const findingIds = [SECOND_GAP_ID, GAP_ID, GAP_ID];
    const result = await runResearchJob(researchJob({
      findingIds,
      lintJobId: 'lint-1',
      subjectId: 's1',
      remediationContext: remediationContext([GAP_ID, SECOND_GAP_ID]),
    }), vi.fn());

    expect(result.topics).toEqual(['gRPC streaming', 'Reactive backpressure']);
    expect(queueMock.get).toHaveBeenCalledWith('lint-1');
    expect(genMock.generateStructuredOutput).toHaveBeenCalledTimes(1);
  });

  it('thin-page remediation context 可由 worker scope 解析并消费', async () => {
    genMock.generateStructuredOutput.mockResolvedValueOnce({ queries: ['thin page sources'] });
    const result = await runResearchJob(researchJob({
      findingIds: [THIN_PAGE_ID],
      lintJobId: 'lint-1',
      subjectId: 's1',
      remediationContext: remediationContext([THIN_PAGE_ID]),
    }), vi.fn());

    expect(result.topics).toEqual(['Thin page without sources']);
    expect(queueMock.get).toHaveBeenCalledWith('lint-1');
  });

  it('query 生成失败 → job 失败（抛出）', async () => {
    genMock.generateStructuredOutput.mockRejectedValueOnce(new Error('llm down'));
    await expect(runResearchJob(researchJob({ topic: 'x' }), vi.fn())).rejects.toThrow('llm down');
  });

  it('单条搜索失败 → 跳过该 query，不影响其余候选', async () => {
    genMock.generateStructuredOutput
      .mockResolvedValueOnce({ queries: ['q1', 'q2'] })
      .mockResolvedValueOnce({ results: [{ url: 'https://ok.com', score: 3, reason: 'ok' }] });
    searchMock.webSearch
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([{ title: 'OK', url: 'https://ok.com', snippet: 'ok' }]);

    const result = await runResearchJob(researchJob({ topic: 'x' }), vi.fn());
    expect(result.candidates).toEqual([
      { url: 'https://ok.com', title: 'OK', snippet: 'ok', score: 3, reason: 'ok' },
    ]);
  });

  it('triage 失败 → 降级为按排名前 3 未评分', async () => {
    genMock.generateStructuredOutput
      .mockResolvedValueOnce({ queries: ['q1'] })
      .mockRejectedValueOnce(new Error('triage down'));
    searchMock.webSearch.mockResolvedValueOnce([
      { title: 'A', url: 'https://a.com', snippet: 'a' },
      { title: 'B', url: 'https://b.com', snippet: 'b' },
    ]);

    const result = await runResearchJob(researchJob({ topic: 'x' }), vi.fn());
    expect(result.candidates).toEqual([
      { url: 'https://a.com', title: 'A', snippet: 'a', score: null, reason: null },
      { url: 'https://b.com', title: 'B', snippet: 'b', score: null, reason: null },
    ]);
  });

  it('零候选 → 短路返回空数组，不调 triage', async () => {
    genMock.generateStructuredOutput.mockResolvedValueOnce({ queries: ['q1'] });
    const result = await runResearchJob(researchJob({ topic: 'x' }), vi.fn());
    expect(result.candidates).toEqual([]);
    expect(genMock.generateStructuredOutput).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['畸形 JSON', researchJob({}, { paramsJson: '{' }), /valid JSON/],
    ['非对象 JSON', researchJob([], { paramsJson: '[]' }), /must be an object/],
    ['topic 显式携带旧 gapIds', researchJob({ topic: 'x', gapIds: ['1'] }), /gapIds/],
    ['findingIds 显式携带旧 gapIds', researchJob({ findingIds: [GAP_ID], lintJobId: 'lint-1', gapIds: null }), /gapIds/],
    ['job subjectId 为空，即使 params 提供 subjectId', researchJob({ topic: 'x', subjectId: 's1' }, { subjectId: null }), /missing subjectId/],
    ['subjectId 类型错误', researchJob({ topic: 'x', subjectId: 1 }), /subjectId/],
    ['job 与 params subjectId 不一致', researchJob({ topic: 'x', subjectId: 's2' }), /does not match/],
    ['topic 与 findingIds 同时存在', researchJob({ topic: 'x', findingIds: [GAP_ID], lintJobId: 'lint-1' }), /exactly one/],
    ['topic 与 findingIds 都不存在', researchJob({ subjectId: 's1' }), /exactly one/],
    ['findingIds 为空', researchJob({ findingIds: [], lintJobId: 'lint-1' }), /findingIds/],
    ['findingId 非小写 64 hex', researchJob({ findingIds: ['A'.repeat(64)], lintJobId: 'lint-1' }), /findingIds/],
    ['findingIds 超过 100 项', researchJob({ findingIds: TOO_MANY_FINDING_IDS, lintJobId: 'lint-1', remediationContext: remediationContext(TOO_MANY_FINDING_IDS) }), /100/],
    ['findingIds 缺 lintJobId', researchJob({ findingIds: [GAP_ID] }), /lintJobId/],
    ['findingIds 缺处置上下文', researchJob({ findingIds: [GAP_ID], lintJobId: 'lint-1' }), /context/],
    ['处置上下文非对象', researchJob({ findingIds: [GAP_ID], lintJobId: 'lint-1', remediationContext: 'bad' }), /context/],
    ['处置 action 不匹配', researchJob({ findingIds: [GAP_ID], lintJobId: 'lint-1', remediationContext: remediationContext([GAP_ID], { action: 'fix' }) }), /action/],
    ['处置 lintJobId 不匹配', researchJob({ findingIds: [GAP_ID], lintJobId: 'lint-1', remediationContext: remediationContext([GAP_ID], { lintJobId: 'lint-2' }) }), /context.*match/],
    ['处置 findingIds 不匹配', researchJob({ findingIds: [GAP_ID], lintJobId: 'lint-1', remediationContext: remediationContext([SECOND_GAP_ID]) }), /context.*match/],
    ['topic 路径携带处置上下文', researchJob({ topic: 'x', remediationContext: remediationContext() }), /context/],
  ] as const)('%s 时在调用 LLM 前拒绝', async (_label, invalidJob, message) => {
    await expect(runResearchJob(invalidJob, vi.fn())).rejects.toThrow(message);
    expect(queueMock.get).not.toHaveBeenCalled();
    expect(genMock.generateStructuredOutput).not.toHaveBeenCalled();
    expect(searchMock.webSearch).not.toHaveBeenCalled();
  });
});
