import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PostconditionReport } from '@/lib/contracts';

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
const genMock = vi.hoisted(() => ({ generateTextWithTools: vi.fn(async () => ({ text: 'done' })) }));
vi.mock('@/server/llm/provider-registry', () => genMock);
vi.mock('@/server/db/repos/subjects-repo', () => ({ getById: vi.fn(() => ({ id: 's1', slug: 'general', name: 'G', description: '' })) }));
const pagesMock = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'a', title: 'A', summary: '', tags: [] }, { slug: 'b', title: 'B', summary: '', tags: [] }]),
  getPageBySlug: vi.fn(() => ({ slug: 'a', title: 'A', summary: '', tags: [] })),
  isMetaPage: vi.fn(() => false),
}));
vi.mock('@/server/db/repos/pages-repo', () => pagesMock);
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'A', created: '', updated: '', tags: [], sources: [] }, body: 'body' })),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));
const embedMock = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('@/server/services/embedding-service', () => embedMock);
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));
vi.mock('@/server/wiki/page-ops', () => ({ executePageUpdate: vi.fn(async () => ({ updatedSlug: 'a' })), executePageCreate: vi.fn(async () => ({ createdSlug: 'x' })) }));
const txMock = vi.hoisted(() => ({
  createChangeset: vi.fn((id: string, s: { id: string; slug: string }, entries: unknown[]) => ({ id, subjectId: s.id, subjectSlug: s.slug, entries })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(async () => undefined),
}));
vi.mock('@/server/wiki/wiki-transaction', () => txMock);
const lintMock = vi.hoisted(() => ({ runDeterministicChecksForSubject: vi.fn(() => [] as Array<{ type: string; pageSlug: string; description: string; suggestedFix: string | null }>) }));
vi.mock('@/server/services/lint-deterministic', () => lintMock);
const latestMock = vi.hoisted(() => ({ selectLatestFindings: vi.fn(() => ({ findings: [] as Array<{ type: string; pageSlug: string; description: string; suggestedFix: string | null }> })) }));
vi.mock('@/server/services/lint-latest', () => latestMock);
vi.mock('@/server/jobs/queue', () => ({ list: vi.fn(() => []) }));
const postconditionMock = vi.hoisted(() => ({ verifyJobPostconditions: vi.fn() }));
vi.mock('@/server/services/postcondition-service', () => postconditionMock);

import { runFixJob } from '../fix-service';

function job() {
  return { id: 'j1', type: 'fix', subjectId: 's1', paramsJson: JSON.stringify({ subjectId: 's1' }) } as never;
}

const cleanReport: PostconditionReport = {
  status: 'clean',
  checkedAt: '2026-07-12T08:00:00.000Z',
  scope: {
    jobId: 'j1',
    subjectId: 's1',
    createdSlugs: [],
    updatedSlugs: [],
    deletedSlugs: [],
    touchedSlugs: [],
    operationIds: [],
  },
  residualFindings: [],
  semanticStatus: 'not-needed',
  verificationError: null,
};

describe('runFixJob (tool-loop)', () => {
  beforeEach(() => {
    genMock.generateTextWithTools.mockClear();
    embedMock.enqueueEmbedIndex.mockClear();
    txMock.applyChangeset.mockClear();
    lintMock.runDeterministicChecksForSubject.mockReturnValue([]);
    latestMock.selectLatestFindings.mockReturnValue({ findings: [] });
    postconditionMock.verifyJobPostconditions.mockReset();
    postconditionMock.verifyJobPostconditions.mockResolvedValue(cleanReport);
  });

  it('只有链接 finding 时使用 fix:links，提供页面与来源证据及 patch', async () => {
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([{ type: 'broken-link', pageSlug: 'a', description: '[[Ghost]] missing', suggestedFix: null }]);
    const emit = vi.fn();
    const res = await runFixJob(job(), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (genMock.generateTextWithTools.mock.calls as any[]);
    expect(calls[0][0]).toBe('fix');
    const opts = calls[0][1];
    const toolKeys = Object.keys(opts.tools);
    expect(toolKeys).toEqual(expect.arrayContaining([
      'wiki_read', 'wiki_search', 'wiki_inspect', 'source_search', 'source_read', 'wiki_patch',
    ]));
    expect(toolKeys).not.toContain('wiki_list');
    expect(toolKeys).not.toContain('wiki_update');
    expect(toolKeys).not.toContain('wiki_create');
    expect(emit).toHaveBeenCalledWith('fix:start', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(res).toMatchObject({
      writes: expect.any(Number),
      postconditionStatus: 'clean',
      postcondition: cleanReport,
    });
  });

  it('只有 missing-frontmatter → pre-pass 一个 commit，不调 LLM', async () => {
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([{ type: 'missing-frontmatter', pageSlug: 'a', description: 'missing title', suggestedFix: null }]);
    const emit = vi.fn();
    await runFixJob(job(), emit);
    expect(txMock.applyChangeset).toHaveBeenCalledOnce();
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:deterministic', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(embedMock.enqueueEmbedIndex).toHaveBeenCalled();
  });

  it('含 contradiction 时使用 fix:contradiction，额外提供 wiki_update', async () => {
    const contradiction = { type: 'contradiction', pageSlug: 'a', description: 'A 与 B 冲突', suggestedFix: null };
    latestMock.selectLatestFindings.mockReturnValueOnce({ findings: [contradiction] });
    const emit = vi.fn();
    await runFixJob(job(), emit);
    const opts = (genMock.generateTextWithTools.mock.calls[0] as unknown[])[1] as { tools: Record<string, unknown> };
    expect(Object.keys(opts.tools)).toContain('wiki_update');
    expect(Object.keys(opts.tools)).not.toContain('wiki_list');
    expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'fix',
      job: expect.objectContaining({ id: 'j1' }),
      semanticFindings: [contradiction],
      emit,
    }));
  });

  it('worklist 空 → 不调 LLM、不 commit，仍 emit complete', async () => {
    const emit = vi.fn();
    await runFixJob(job(), emit);
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(txMock.applyChangeset).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();
    expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledOnce();
  });

  it('residual 报告仍正常完成并进入结果与 complete 事件', async () => {
    const residualReport: PostconditionReport = {
      ...cleanReport,
      status: 'residual',
      residualFindings: [
        {
          type: 'broken-link',
          severity: 'warning',
          pageSlug: 'a',
          description: '仍有坏链',
        },
      ],
    };
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce(residualReport);
    const emit = vi.fn();

    const result = await runFixJob(job(), emit);

    expect(result).toMatchObject({
      postconditionStatus: 'residual',
      postcondition: residualReport,
    });
    expect(emit).toHaveBeenCalledWith(
      'fix:complete',
      expect.stringContaining('Postcondition residual'),
      expect.objectContaining({
        postconditionStatus: 'residual',
        residualCount: 1,
      }),
    );
  });
});
