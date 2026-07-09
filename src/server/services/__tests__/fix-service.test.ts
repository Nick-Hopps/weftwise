import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { runFixJob } from '../fix-service';

function job() {
  return { id: 'j1', subjectId: 's1', paramsJson: JSON.stringify({ subjectId: 's1' }) } as never;
}

describe('runFixJob (tool-loop)', () => {
  beforeEach(() => {
    genMock.generateTextWithTools.mockClear();
    embedMock.enqueueEmbedIndex.mockClear();
    txMock.applyChangeset.mockClear();
    lintMock.runDeterministicChecksForSubject.mockReturnValue([]);
    latestMock.selectLatestFindings.mockReturnValue({ findings: [] });
  });

  it('有 loop findings → 驱动 generateTextWithTools(fix) + 工具集含 wiki_update、不含 wiki_create + emit start/complete', async () => {
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([{ type: 'broken-link', pageSlug: 'a', description: '[[Ghost]] missing', suggestedFix: null }]);
    const emit = vi.fn();
    const res = await runFixJob(job(), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (genMock.generateTextWithTools.mock.calls as any[]);
    expect(calls[0][0]).toBe('fix');
    const opts = calls[0][1];
    const toolKeys = Object.keys(opts.tools);
    expect(toolKeys).toEqual(expect.arrayContaining(['wiki_read', 'wiki_search', 'wiki_list', 'wiki_update']));
    expect(toolKeys).not.toContain('wiki_create');
    expect(emit).toHaveBeenCalledWith('fix:start', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(res).toHaveProperty('writes');
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

  it('worklist 空 → 不调 LLM、不 commit，仍 emit complete', async () => {
    const emit = vi.fn();
    await runFixJob(job(), emit);
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(txMock.applyChangeset).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();
  });
});
