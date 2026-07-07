import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));

const queueMock = vi.hoisted(() => ({ list: vi.fn(() => [] as unknown[]) }));
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

import { runResearchJob, resolveTopicsFromGapIds } from '../research-service';

function job(params: object) {
  return { id: 'j1', subjectId: 's1', paramsJson: JSON.stringify(params) } as never;
}

describe('runResearchJob', () => {
  beforeEach(() => {
    genMock.generateStructuredOutput.mockReset();
    searchMock.webSearch.mockReset();
    searchMock.webSearch.mockResolvedValue([]);
    queueMock.list.mockReturnValue([]);
  });

  it('manual topic：三阶段成功 → 返回 triage 过滤后的候选', async () => {
    genMock.generateStructuredOutput
      .mockResolvedValueOnce({ queries: ['rust async runtimes'] }) // stage 1
      .mockResolvedValueOnce({
        results: [
          { url: 'https://a.com', score: 3, reason: 'great' },
          { url: 'https://b.com', score: 1, reason: 'weak' },
        ],
      }); // stage 3
    searchMock.webSearch.mockResolvedValueOnce([
      { title: 'A', url: 'https://a.com', snippet: 'a' },
      { title: 'B', url: 'https://b.com', snippet: 'b' },
    ]);

    const emit = vi.fn();
    const result = await runResearchJob(job({ topic: 'Rust async runtimes' }), emit);

    expect(result.candidates).toEqual([
      { url: 'https://a.com', title: 'A', snippet: 'a', score: 3, reason: 'great' },
    ]);
    expect(emit).toHaveBeenCalledWith('research:complete', expect.any(String), expect.any(Object));
  });

  it('query 生成失败 → job 失败（抛出）', async () => {
    genMock.generateStructuredOutput.mockRejectedValueOnce(new Error('llm down'));
    const emit = vi.fn();
    await expect(runResearchJob(job({ topic: 'x' }), emit)).rejects.toThrow('llm down');
  });

  it('单条搜索失败 → 跳过该 query，不影响其余候选', async () => {
    genMock.generateStructuredOutput
      .mockResolvedValueOnce({ queries: ['q1', 'q2'] })
      .mockResolvedValueOnce({ results: [{ url: 'https://ok.com', score: 3, reason: 'ok' }] });
    searchMock.webSearch
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([{ title: 'OK', url: 'https://ok.com', snippet: 'ok' }]);

    const emit = vi.fn();
    const result = await runResearchJob(job({ topic: 'x' }), emit);
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

    const emit = vi.fn();
    const result = await runResearchJob(job({ topic: 'x' }), emit);
    expect(result.candidates).toEqual([
      { url: 'https://a.com', title: 'A', snippet: 'a', score: null, reason: null },
      { url: 'https://b.com', title: 'B', snippet: 'b', score: null, reason: null },
    ]);
  });

  it('零候选 → 短路返回空数组，不调 triage', async () => {
    genMock.generateStructuredOutput.mockResolvedValueOnce({ queries: ['q1'] });
    searchMock.webSearch.mockResolvedValueOnce([]);
    const emit = vi.fn();
    const result = await runResearchJob(job({ topic: 'x' }), emit);
    expect(result.candidates).toEqual([]);
    expect(genMock.generateStructuredOutput).toHaveBeenCalledTimes(1);
  });

  it('gapIds 引用最近 lint 快照的 coverage-gap findings', async () => {
    queueMock.list.mockReturnValue([
      {
        id: 'lint1',
        type: 'lint',
        status: 'completed',
        completedAt: '2026-01-01T00:00:00.000Z',
        resultJson: JSON.stringify({
          findings: [
            { type: 'broken-link', description: 'irrelevant', severity: 'warning', pageSlug: 'x', suggestedFix: null },
            { type: 'coverage-gap', description: 'gRPC streaming', severity: 'info', pageSlug: 'gRPC streaming', suggestedFix: null },
          ],
        }),
      },
    ]);
    expect(resolveTopicsFromGapIds('s1', ['1'])).toEqual(['gRPC streaming']);
    expect(resolveTopicsFromGapIds('s1', ['0'])).toEqual([]); // index 0 不是 coverage-gap
    expect(resolveTopicsFromGapIds('s1', ['99'])).toEqual([]); // 越界
  });

  it('gapIds 无有效主题且无 topic → 抛错', async () => {
    queueMock.list.mockReturnValue([]);
    const emit = vi.fn();
    await expect(runResearchJob(job({ gapIds: ['0'] }), emit)).rejects.toThrow(/No topics/);
  });
});
