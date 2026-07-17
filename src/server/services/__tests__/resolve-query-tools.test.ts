import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetWebSearchConfig = vi.fn();

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
vi.mock('@/server/db/repos/settings-repo', () => ({
  getWikiLanguage: () => 'English',
  getWebSearchConfig: () => mockGetWebSearchConfig(),
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('resolveQueryTools', () => {
  it('excludes web.search when web search is not configured', async () => {
    mockGetWebSearchConfig.mockReturnValue({ provider: 'tavily', apiKey: '', maxResults: 5 });
    const { resolveQueryTools } = await import('../query-service');
    const names = resolveQueryTools().map((t) => t.name);
    expect(names).not.toContain('web.search');
    expect(names).toEqual(expect.arrayContaining([
      'subject.list', 'wiki.list', 'wiki.search', 'wiki.read',
      'wiki.search_cross_subject', 'wiki.read_cross_subject',
      'wiki.inspect', 'source.search', 'source.read',
      'history.list', 'history.diff',
      'workflow.status',
    ]));
    expect(names).not.toContain('wiki.update');
    expect(names).not.toContain('wiki.delete');
  });

  it('includes web.search when web search is configured', async () => {
    mockGetWebSearchConfig.mockReturnValue({ provider: 'tavily', apiKey: 'sk-123', maxResults: 5 });
    const { resolveQueryTools } = await import('../query-service');
    const names = resolveQueryTools().map((t) => t.name);
    expect(names).toContain('web.search');
    expect(names).toEqual(expect.arrayContaining(['wiki.inspect', 'source.search', 'source.read']));
    expect(names).not.toContain('wiki.update');
  });

  it('propose 默认只额外解析通用审批提案工具', async () => {
    mockGetWebSearchConfig.mockReturnValue({ provider: 'tavily', apiKey: '', maxResults: 5 });
    const { resolveQueryTools } = await import('../query-service');
    const read = resolveQueryTools('read').map((tool) => tool.name);
    const propose = resolveQueryTools('propose').map((tool) => tool.name);
    expect(propose).toEqual([
      ...read,
      'wiki.preview_change',
      'history.revert',
      'workflow.reenrich.start',
      'workflow.research.start',
      'workflow.cancel',
      'wiki.reenrich',
      'wiki.move',
    ]);
    expect(propose).not.toEqual(expect.arrayContaining([
      'wiki.create', 'wiki.update', 'wiki.patch', 'wiki.delete', 'wiki.reenrich',
      'wiki.metadata.patch', 'wiki.link.ensure', 'image.generate',
    ]));
  });

  it('只有 LLM 分类确认后才解析选区配图提案工具', async () => {
    mockGetWebSearchConfig.mockReturnValue({ provider: 'tavily', apiKey: '', maxResults: 5 });
    const { resolveQueryTools } = await import('../query-service');
    const ordinary = resolveQueryTools('propose').map((tool) => tool.name);
    const imageInsert = resolveQueryTools('propose', { imageInsertEnabled: true })
      .map((tool) => tool.name);

    expect(ordinary).not.toContain('wiki.image.insert');
    expect(imageInsert).toEqual([...ordinary, 'wiki.image.insert']);
  });
});
