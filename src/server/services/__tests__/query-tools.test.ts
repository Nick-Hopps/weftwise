import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetAllPages = vi.fn();
const mockGetPageBySlug = vi.fn();
const mockHybrid = vi.fn();
const mockReadPage = vi.fn();
const mockCreatePendingActionPreview = vi.fn();

vi.mock('@/server/db/repos/pages-repo', () => ({
  getAllPages: (...a: unknown[]) => mockGetAllPages(...a),
  getPageBySlug: (...a: unknown[]) => mockGetPageBySlug(...a),
  isMetaPage: (p: { tags?: string[] }) => (p.tags ?? []).includes('meta'),
}));
vi.mock('@/server/search/hybrid-retrieval', () => ({
  hybridRankSlugs: (...a: unknown[]) => mockHybrid(...a),
}));
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: (...a: unknown[]) => mockReadPage(...a),
}));
vi.mock('../pending-action-service', () => ({
  createPendingActionPreview: (...a: unknown[]) => mockCreatePendingActionPreview(...a),
}));

const mockWebSearch = vi.fn();
vi.mock('@/server/search/web-search', () => ({
  webSearch: (...a: unknown[]) => mockWebSearch(...a),
}));

import {
  buildQueryToolContext,
  createAccessedPages,
  accessedToContext,
  subjectHasContent,
} from '../query-tools';

const SUBJECT = {
  id: 's1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard' as const,
  createdAt: 't',
  updatedAt: 't',
};

function page(slug: string, over: Record<string, unknown> = {}) {
  return {
    subjectId: 's1',
    slug,
    title: slug.toUpperCase(),
    path: `wiki/general/${slug}.md`,
    summary: `summary-${slug}`,
    contentHash: 'h',
    tags: [] as string[],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  mockGetAllPages.mockReset();
  mockGetPageBySlug.mockReset();
  mockHybrid.mockReset();
  mockReadPage.mockReset();
  mockCreatePendingActionPreview.mockReset();
});

describe('buildQueryToolContext - listPages', () => {
  it('委托 evidence reader，过滤 meta 并按默认 title 排序', async () => {
    mockGetAllPages.mockReturnValue([
      page('a', { updatedAt: '2026-01-01T00:00:00Z' }),
      page('idx', { tags: ['meta'], updatedAt: '2026-09-09T00:00:00Z' }),
      page('b', { updatedAt: '2026-05-05T00:00:00Z' }),
    ]);
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    const result = await ctx.listPages();
    expect(result.pages.map((p) => p.slug)).toEqual(['a', 'b']);
    expect(result.pages.find((p) => p.slug === 'idx')).toBeUndefined();
    expect(result.nextCursor).toBeNull();
    // wiki.list tool 会对每个页调用 onAccess({ slug, title })（无 body）→ meta
    ctx.onAccess?.({ slug: 'b', title: 'B' });
    expect(accessed.meta.has('b')).toBe(true);
    expect(accessed.meta.has('idx')).toBe(false);
  });
});

describe('buildQueryToolContext - search', () => {
  it('走 hybridRankSlugs、跳过 meta、onAccess 写 accessed.meta、返回 hits', async () => {
    mockHybrid.mockResolvedValue(['b', 'meta-pg', 'gone']);
    mockGetPageBySlug.mockImplementation((_s: string, slug: string) => {
      if (slug === 'b') return page('b');
      if (slug === 'meta-pg') return page('meta-pg', { tags: ['meta'] });
      return null; // 'gone' 已删
    });
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    const hits = await ctx.search('foo', 5);
    expect(mockHybrid).toHaveBeenCalledWith('s1', 'foo', 5);
    expect(hits.map((h) => h.slug)).toEqual(['b']);
    // wiki.search tool 会对命中页调用 onAccess({ slug, title })（无 body）→ meta
    ctx.onAccess?.({ slug: 'b', title: 'B' });
    expect(accessed.meta.has('b')).toBe(true);
  });
});

describe('buildQueryToolContext - readPage', () => {
  it('命中返回 {title, markdown}；onAccess 带 body 写 accessed.bodies', async () => {
    mockGetPageBySlug.mockImplementation((_s: string, slug: string) =>
      slug === 'b' ? page('b') : null,
    );
    mockReadPage.mockImplementation((_subject: string, slug: string) =>
      slug === 'b' ? { body: 'BODY-B' } : null,
    );
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    const ok = await ctx.readPage('b');
    expect(ok).toEqual({ title: 'B', markdown: 'BODY-B' });
    // wiki.read tool 会调用 onAccess({ slug, title, body: p.markdown }) → bodies
    ctx.onAccess?.({ slug: 'b', title: 'B', body: 'BODY-B' });
    expect(accessed.bodies.get('b')?.body).toBe('BODY-B');
  });

  it('不存在/空正文返回 null', async () => {
    mockGetPageBySlug.mockImplementation(() => null);
    mockReadPage.mockImplementation(() => null);
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    const miss = await ctx.readPage('nope');
    expect(miss).toBeNull();
  });
});

describe('accessedToContext', () => {
  it('read 过的用全文；只搜索未读的按需补读；去重', () => {
    const accessed = createAccessedPages();
    accessed.bodies.set('b', { title: 'B', body: 'FULL-B' });
    accessed.meta.set('b', { title: 'B', summary: 's' }); // 同时在 meta，应去重
    accessed.meta.set('c', { title: 'C', summary: 's' }); // 仅搜索过，需补读
    mockReadPage.mockImplementation((_slug: string, slug: string) =>
      slug === 'c' ? { body: 'FULL-C' } : null,
    );
    const ctx = accessedToContext(SUBJECT, accessed);
    expect(ctx).toEqual([
      { slug: 'b', title: 'B', content: 'FULL-B' },
      { slug: 'c', title: 'C', content: 'FULL-C' },
    ]);
  });
});

describe('subjectHasContent', () => {
  it('有非 meta 页 → true；仅 meta/空 → false', () => {
    mockGetAllPages.mockReturnValueOnce([page('a'), page('idx', { tags: ['meta'] })]);
    expect(subjectHasContent('s1')).toBe(true);
    mockGetAllPages.mockReturnValueOnce([page('idx', { tags: ['meta'] })]);
    expect(subjectHasContent('s1')).toBe(false);
    mockGetAllPages.mockReturnValueOnce([]);
    expect(subjectHasContent('s1')).toBe(false);
  });
});

describe('buildQueryToolContext - onAccess 路由', () => {
  it('body 非空 → 写 bodies，不写 meta', () => {
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onAccess?.({ slug: 'c', title: 'C', body: 'full-body' });
    expect(accessed.bodies.get('c')).toEqual({ title: 'C', body: 'full-body' });
    expect(accessed.meta.has('c')).toBe(false);
  });

  it('body 未传 → 写 meta（bodies 未收录时）', () => {
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onAccess?.({ slug: 'b', title: 'B' });
    expect(accessed.meta.has('b')).toBe(true);
    expect(accessed.bodies.has('b')).toBe(false);
  });

  it('bodies 已收录时 onAccess 不降级写 meta', () => {
    const accessed = createAccessedPages();
    accessed.bodies.set('d', { title: 'D', body: 'body-d' });
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onAccess?.({ slug: 'd', title: 'D' }); // 无 body，但 bodies 已有
    expect(accessed.meta.has('d')).toBe(false); // 不应降级写 meta
  });

  it('onSourceAccess 对相同 source/chunk 去重且不保存正文', () => {
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onSourceAccess?.({ sourceId: 'src1', chunkId: 'c0' });
    ctx.onSourceAccess?.({ sourceId: 'src1', chunkId: 'c0' });
    ctx.onSourceAccess?.({ sourceId: 'src1', chunkId: 'c1' });

    expect([...accessed.sourceRefs.values()]).toEqual([
      { sourceId: 'src1', chunkId: 'c0' },
      { sourceId: 'src1', chunkId: 'c1' },
    ]);
  });
});

describe('buildQueryToolContext - 只读能力面', () => {
  it('不注入任何写入、删除或入队能力', () => {
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    for (const capability of ['reenrich', 'deletePage', 'createPage', 'updatePage', 'patchPage']) {
      expect(capability in ctx).toBe(false);
    }
    expect(ctx.inspectPage).toBeTypeOf('function');
    expect(ctx.searchSources).toBeTypeOf('function');
    expect(ctx.readSource).toBeTypeOf('function');
    expect(ctx.previewChange).toBeUndefined();
  });
});

describe('buildQueryToolContext - 审批预览能力面', () => {
  it('仅在提供 conversationId 时注入 subject-scoped 预览服务与回调', async () => {
    const action = { actionId: 'action-1' };
    mockCreatePendingActionPreview.mockResolvedValue(action);
    const onPendingAction = vi.fn();
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages(), {
      conversationId: 'conversation-1',
      onPendingAction,
    });
    const input = { operation: 'delete' as const, payload: { slug: 'old-page' } };

    await expect(ctx.previewChange?.(input)).resolves.toBe(action);
    expect(mockCreatePendingActionPreview).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      subject: SUBJECT,
      input,
    });
    expect(ctx.conversationId).toBe('conversation-1');
    expect(ctx.onPendingAction).toBe(onPendingAction);
  });
});

describe('buildQueryToolContext - webSearch', () => {
  it('委托底层 webSearch(query)', async () => {
    mockWebSearch.mockReset();
    mockWebSearch.mockResolvedValue([{ title: 'T', url: 'https://x', snippet: 'S' }]);
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    const out = await ctx.webSearch!('foo');
    expect(mockWebSearch).toHaveBeenCalledWith('foo');
    expect(out).toEqual([{ title: 'T', url: 'https://x', snippet: 'S' }]);
  });
});
