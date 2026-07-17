import { afterEach, describe, expect, it, vi } from 'vitest';
import { zodSchema } from 'ai';

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

  it('image-insert mode 只解析 read 工具与选区配图工具', async () => {
    mockGetWebSearchConfig.mockReturnValue({ provider: 'tavily', apiKey: '', maxResults: 5 });
    const { resolveQueryTools } = await import('../query-service');
    const read = resolveQueryTools('read').map((tool) => tool.name);
    const ordinary = resolveQueryTools('propose').map((tool) => tool.name);
    const imageInsert = resolveQueryTools('image-insert').map((tool) => tool.name);

    expect(ordinary).not.toContain('wiki.image.insert');
    expect(imageInsert).toEqual([...read, 'wiki.image.insert']);
    expect(imageInsert).not.toEqual(expect.arrayContaining([
      'wiki.preview_change',
      'history.revert',
      'workflow.reenrich.start',
      'workflow.research.start',
      'workflow.cancel',
      'wiki.reenrich',
      'wiki.move',
    ]));
  });

  it('image-insert mode 的全部 provider schema 都以 object 为根', async () => {
    mockGetWebSearchConfig.mockReturnValue({ provider: 'tavily', apiKey: '', maxResults: 5 });
    const { resolveQueryTools } = await import('../query-service');

    for (const tool of resolveQueryTools('image-insert')) {
      const schema = await zodSchema(tool.inputSchema).jsonSchema;
      expect(schema, tool.name).toMatchObject({ type: 'object' });
    }
  });
});
