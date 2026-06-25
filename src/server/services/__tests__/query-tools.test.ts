import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetAllPages = vi.fn();
const mockGetPageBySlug = vi.fn();
const mockHybrid = vi.fn();
const mockReadPage = vi.fn();

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

import {
  buildQueryTools,
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
});

describe('list_pages', () => {
  it('过滤 meta、按 updatedAt 倒序、写入 accessed.meta', async () => {
    mockGetAllPages.mockReturnValue([
      page('a', { updatedAt: '2026-01-01T00:00:00Z' }),
      page('idx', { tags: ['meta'], updatedAt: '2026-09-09T00:00:00Z' }),
      page('b', { updatedAt: '2026-05-05T00:00:00Z' }),
    ]);
    const accessed = createAccessedPages();
    const tools = buildQueryTools(SUBJECT, accessed);
    const out = await tools.list_pages.execute!({}, {} as never);
    expect(out.pages.map((p: { slug: string }) => p.slug)).toEqual(['b', 'a']); // meta 排除，b 更新更晚在前
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(2);
    expect(accessed.meta.has('b')).toBe(true);
    expect(accessed.meta.has('idx')).toBe(false);
  });
});

describe('search_wiki', () => {
  it('走 hybridRankSlugs、跳过 meta、写 accessed.meta、返回 hits', async () => {
    mockHybrid.mockResolvedValue(['b', 'meta-pg', 'gone']);
    mockGetPageBySlug.mockImplementation((_s: string, slug: string) => {
      if (slug === 'b') return page('b');
      if (slug === 'meta-pg') return page('meta-pg', { tags: ['meta'] });
      return null; // 'gone' 已删
    });
    const accessed = createAccessedPages();
    const tools = buildQueryTools(SUBJECT, accessed);
    const out = await tools.search_wiki.execute!({ query: 'foo', limit: 5 }, {} as never);
    expect(mockHybrid).toHaveBeenCalledWith('s1', 'foo', 5);
    expect(out.hits.map((h: { slug: string }) => h.slug)).toEqual(['b']);
    expect(accessed.meta.has('b')).toBe(true);
  });
});

describe('read_page', () => {
  it('命中写 accessed.bodies；不存在/空正文返回 error', async () => {
    mockGetPageBySlug.mockImplementation((_s: string, slug: string) =>
      slug === 'b' ? page('b') : null,
    );
    mockReadPage.mockImplementation((_slug: string, slug: string) =>
      slug === 'b' ? { body: 'BODY-B' } : null,
    );
    const accessed = createAccessedPages();
    const tools = buildQueryTools(SUBJECT, accessed);
    const ok = await tools.read_page.execute!({ slug: 'b' }, {} as never);
    expect(ok).toMatchObject({ slug: 'b', title: 'B', body: 'BODY-B' });
    expect(accessed.bodies.get('b')?.body).toBe('BODY-B');

    const miss = await tools.read_page.execute!({ slug: 'nope' }, {} as never);
    expect(miss).toHaveProperty('error');
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
