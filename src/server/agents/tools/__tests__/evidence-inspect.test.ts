import { beforeEach, describe, expect, it, vi } from 'vitest';

const pages = vi.hoisted(() => ({
  getPageBySlug: vi.fn(),
  getAllLinks: vi.fn(),
  getBacklinks: vi.fn(),
  isMetaPage: vi.fn((page: { tags?: string[] }) => (page.tags ?? []).includes('meta')),
}));
const subjects = vi.hoisted(() => ({ getById: vi.fn() }));
const sources = vi.hoisted(() => ({ getSourcesForPage: vi.fn() }));
const sourceStore = vi.hoisted(() => ({ getSourceMetadata: vi.fn() }));
const staleness = vi.hoisted(() => ({ isSourceStale: vi.fn() }));

vi.mock('@/server/db/repos/pages-repo', () => pages);
vi.mock('@/server/db/repos/subjects-repo', () => subjects);
vi.mock('@/server/db/repos/sources-repo', () => sources);
vi.mock('@/server/sources/source-store', () => sourceStore);
vi.mock('@/server/sources/source-staleness', () => staleness);

import { emptyWikiInspection, inspectPageEvidence } from '../evidence-reader';

const subject = {
  id: 's1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as const;

function page(subjectId: string, slug: string, over: Record<string, unknown> = {}) {
  return {
    subjectId,
    slug,
    title: slug.toUpperCase(),
    path: `wiki/${subjectId}/${slug}.md`,
    summary: `summary-${slug}`,
    contentHash: 'hash',
    tags: [] as string[],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pages.getPageBySlug.mockImplementation((subjectId: string, slug: string) => {
    if (subjectId === 's1' && slug === 'a') return page('s1', 'a', { title: 'A', tags: ['topic'] });
    if (subjectId === 's1' && slug === 'b') return page('s1', 'b', { title: 'B' });
    if (subjectId === 's2' && slug === 'cross') return page('s2', 'cross', { title: 'Cross' });
    return null;
  });
  pages.getAllLinks.mockReturnValue([]);
  pages.getBacklinks.mockReturnValue([]);
  subjects.getById.mockImplementation((id: string) => (
    id === 's1' ? { id: 's1', slug: 'general' } : id === 's2' ? { id: 's2', slug: 'other' } : null
  ));
  sources.getSourcesForPage.mockReturnValue([]);
  sourceStore.getSourceMetadata.mockReturnValue(null);
  staleness.isSourceStale.mockReturnValue(false);
});

describe('inspectPageEvidence', () => {
  it('返回同主题、跨主题、断链、反链、来源和健康计数，但不返回正文', () => {
    pages.getAllLinks.mockReturnValue([
      { subjectId: 's1', sourceSlug: 'a', targetSubjectId: 's1', targetSlug: 'b', context: 'same' },
      { subjectId: 's1', sourceSlug: 'a', targetSubjectId: 's2', targetSlug: 'cross', context: 'cross' },
      { subjectId: 's1', sourceSlug: 'a', targetSubjectId: 's1', targetSlug: 'ghost', context: 'broken' },
    ]);
    pages.getBacklinks.mockReturnValue([
      page('s1', 'b', { title: 'B' }),
      page('s2', 'cross', { title: 'Cross' }),
    ]);
    sources.getSourcesForPage.mockReturnValue([
      {
        id: 'src1', subjectId: 's1', filename: 'a.md', contentHash: 'h1',
        parsedAt: '2026-01-03', metadataJson: '{}',
      },
      {
        id: 'src2', subjectId: 's1', filename: 'b.md', contentHash: 'h2',
        parsedAt: null, metadataJson: '{}',
      },
    ]);
    sourceStore.getSourceMetadata.mockImplementation((id: string) => (
      id === 'src1' ? { originUrl: 'https://example.test/a' } : null
    ));
    staleness.isSourceStale.mockImplementation((_slug: string, source: { id: string }) => source.id === 'src2');

    const result = inspectPageEvidence(subject, 'a');

    expect(result.page).toEqual({
      slug: 'a', title: 'A', summary: 'summary-a', tags: ['topic'], updatedAt: '2026-01-02',
    });
    expect(result.page).not.toHaveProperty('markdown');
    expect(result.outgoing).toEqual([
      { subjectSlug: 'general', slug: 'b', title: 'B', context: 'same', resolved: true },
      { subjectSlug: 'other', slug: 'cross', title: 'Cross', context: 'cross', resolved: true },
      { subjectSlug: 'general', slug: 'ghost', title: null, context: 'broken', resolved: false },
    ]);
    expect(result.backlinks).toEqual([
      { subjectSlug: 'general', slug: 'b', title: 'B' },
      { subjectSlug: 'other', slug: 'cross', title: 'Cross' },
    ]);
    expect(result.sources).toEqual([
      {
        id: 'src1', filename: 'a.md', originUrl: 'https://example.test/a',
        parsedAt: '2026-01-03', stale: false,
      },
      { id: 'src2', filename: 'b.md', originUrl: null, parsedAt: null, stale: true },
    ]);
    expect(result.health).toEqual({
      brokenLinks: 1, inboundCount: 2, outboundCount: 3, sourceCount: 2,
    });
  });

  it('不存在页面与 meta 页面返回同一个空结果', () => {
    expect(inspectPageEvidence(subject, 'missing')).toEqual(emptyWikiInspection());

    pages.getPageBySlug.mockReturnValue(page('s1', 'index', { tags: ['meta'] }));
    expect(inspectPageEvidence(subject, 'index')).toEqual(emptyWikiInspection());
  });

  it('include 子集不泄露未请求的证据数组', () => {
    pages.getAllLinks.mockReturnValue([
      { subjectId: 's1', sourceSlug: 'a', targetSubjectId: 's1', targetSlug: 'ghost', context: '' },
    ]);
    pages.getBacklinks.mockReturnValue([page('s1', 'b')]);
    sources.getSourcesForPage.mockReturnValue([
      {
        id: 'src1', subjectId: 's1', filename: 'a.md', contentHash: 'h1',
        parsedAt: null, metadataJson: '{}',
      },
    ]);

    const result = inspectPageEvidence(subject, 'a', ['health']);

    expect(result.outgoing).toEqual([]);
    expect(result.backlinks).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.health).toEqual({
      brokenLinks: 1, inboundCount: 1, outboundCount: 1, sourceCount: 1,
    });
  });

  it('sidecar 缺失时从数据库 metadataJson 回落 originUrl', () => {
    sources.getSourcesForPage.mockReturnValue([
      {
        id: 'src1', subjectId: 's1', filename: 'a.md', contentHash: 'h1', parsedAt: null,
        metadataJson: JSON.stringify({ originUrl: 'https://db.example/a' }),
      },
    ]);

    const result = inspectPageEvidence(subject, 'a', ['sources']);

    expect(result.sources[0]?.originUrl).toBe('https://db.example/a');
  });
});
