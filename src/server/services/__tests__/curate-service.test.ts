import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock 路径用 @/server/... 绝对别名（解析到与 SUT import 同一模块；与 query-tools.test 一致）
vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
const genMock = vi.hoisted(() => ({ generateTextWithTools: vi.fn(async () => ({ text: 'done' })) }));
vi.mock('@/server/llm/provider-registry', () => genMock);
vi.mock('@/server/db/repos/subjects-repo', () => ({ getById: vi.fn(() => ({ id: 's1', slug: 'general', name: 'G', description: '' })) }));
const pagesMock = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'a', tags: [] }, { slug: 'b', tags: [] }]),
  getAllLinks: vi.fn(() => []),
  getPageBySlug: vi.fn(() => null), isMetaPage: () => false,
}));
vi.mock('@/server/db/repos/pages-repo', () => pagesMock);
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'T', summary: 's', tags: [] }, body: 'body' })),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));
vi.mock('@/server/services/embedding-service', () => ({ enqueueEmbedIndex: vi.fn() }));
// curate-tools 透传引入；本测试不触发搜索，mock 防 import-time 副作用
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));

import { runCurateJob } from '../curate-service';

function job(params: object) {
  return { id: 'j1', type: 'curate', subjectId: 's1', paramsJson: JSON.stringify(params) } as never;
}

describe('runCurateJob (tool-loop)', () => {
  beforeEach(() => { genMock.generateTextWithTools.mockClear(); });
  it('manual：驱动 generateTextWithTools(curate) + emit start/complete', async () => {
    const emit = vi.fn();
    const res = await runCurateJob(job({ scope: 'subject', subjectId: 's1' }), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (genMock.generateTextWithTools.mock.calls as any[][])[0];
    const [task, opts] = call as [string, { tools: Record<string, unknown> }];
    expect(task).toBe('curate');
    expect(Object.keys(opts.tools)).toEqual(expect.arrayContaining([
      'wiki_merge', 'wiki_split', 'wiki_delete', 'wiki_create', 'wiki_read', 'wiki_inspect',
    ]));
    expect(emit).toHaveBeenCalledWith('curate:start', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('curate:complete', expect.any(String), expect.any(Object));
    expect(res).toHaveProperty('writes');
  });
  it('scope<2 → 提前 complete，不调 LLM', async () => {
    pagesMock.getAllPages.mockReturnValueOnce([{ slug: 'a', tags: [] }]);
    const emit = vi.fn();
    await runCurateJob(job({ scope: 'subject', subjectId: 's1' }), emit);
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('curate:complete', expect.stringMatching(/Nothing to curate/), expect.any(Object));
  });
  it('auto（scope:pages）：seed 驱动 → 用户消息为 AUTOMATIC 模式', async () => {
    // 2 个 seed 页保证 scope>=2 触发 LLM；getAllLinks 返回 [] → scope=seed
    const emit = vi.fn();
    await runCurateJob(job({ scope: 'pages', slugs: ['a', 'b'], subjectId: 's1' }), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    const opts = (genMock.generateTextWithTools.mock.calls[0] as any[])[1];
    // auto 模式只保留 scope 内 read/search/merge/split，无 list/create/delete
    const toolKeys = Object.keys(opts.tools);
    expect(toolKeys).toEqual(expect.arrayContaining([
      'wiki_merge', 'wiki_split', 'wiki_read', 'wiki_inspect',
    ]));
    expect(toolKeys).not.toContain('wiki_create');
    expect(toolKeys).not.toContain('wiki_delete');
    expect(toolKeys).not.toContain('wiki_list');
    const userMsg = String(opts.messages[0].content);
    expect(userMsg).toMatch(/AUTOMATIC/);        // 证明 {auto:true} 传入 → seedSet!==null
    expect(userMsg).toMatch(/do NOT create/i);   // auto 禁建页提示
    expect(emit).toHaveBeenCalledWith('curate:start', expect.any(String), expect.objectContaining({ scope: 'pages' }));
  });
});
