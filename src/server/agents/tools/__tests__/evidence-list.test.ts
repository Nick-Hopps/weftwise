import { beforeEach, describe, expect, it, vi } from 'vitest';

const pages = vi.hoisted(() => ({
  getAllPages: vi.fn(),
  getPageBySlug: vi.fn(),
  getAllLinks: vi.fn(),
  getBacklinks: vi.fn(),
  isMetaPage: vi.fn((page: { tags?: string[] }) => (page.tags ?? []).includes('meta')),
}));
const subjects = vi.hoisted(() => ({ getById: vi.fn() }));
const sources = vi.hoisted(() => ({
  listSourcesForSubject: vi.fn(), getSourcesForPage: vi.fn(), getSource: vi.fn(),
}));

vi.mock('@/server/db/repos/pages-repo', () => pages);
vi.mock('@/server/db/repos/subjects-repo', () => subjects);
vi.mock('@/server/db/repos/sources-repo', () => sources);
vi.mock('@/server/sources/source-store', () => ({ getSourceMetadata: vi.fn() }));
vi.mock('@/server/sources/source-staleness', () => ({ isSourceStale: vi.fn() }));

import { createSubjectEvidenceReader, listPageEvidence } from '../evidence-reader';

const subject = {
  id: 'sub1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as const;

function page(
  slug: string,
  title: string,
  updatedAt: string,
  tags: string[] = [],
) {
  return {
    subjectId: 'sub1', slug, title, updatedAt, tags,
    path: `wiki/general/${slug}.md`, summary: `summary-${slug}`,
    contentHash: `hash-${slug}`, createdAt: '2026-01-01',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pages.getAllPages.mockReturnValue([]);
});

describe('listPageEvidence', () => {
  it('title 排序稳定续页且不会重复', () => {
    pages.getAllPages.mockReturnValue([
      page('c', 'Beta', '2026-01-03'),
      page('a', 'Alpha', '2026-01-01'),
      page('b', 'Alpha', '2026-01-02'),
    ]);

    const first = listPageEvidence(subject, { limit: 2, sort: 'title' });
    expect(first.pages.map((item) => item.slug)).toEqual(['a', 'b']);
    expect(first.nextCursor).not.toBeNull();

    const second = listPageEvidence(subject, {
      limit: 2, sort: 'title', cursor: first.nextCursor!,
    });
    expect(second.pages.map((item) => item.slug)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
  });

  it('updated 排序按 updatedAt 降序、slug 升序续页', () => {
    pages.getAllPages.mockReturnValue([
      page('b', 'B', '2026-01-02'),
      page('a', 'A', '2026-01-02'),
      page('c', 'C', '2026-01-01'),
    ]);

    const first = listPageEvidence(subject, { limit: 2, sort: 'updated' });
    expect(first.pages.map((item) => item.slug)).toEqual(['a', 'b']);

    const second = listPageEvidence(subject, {
      limit: 2, sort: 'updated', cursor: first.nextCursor!,
    });
    expect(second.pages.map((item) => item.slug)).toEqual(['c']);
  });

  it('tag 精确筛选并始终过滤 meta 页面', () => {
    pages.getAllPages.mockReturnValue([
      page('a', 'A', '2026-01-01', ['topic']),
      page('b', 'B', '2026-01-01', ['other']),
      page('index', 'Index', '2026-01-01', ['topic', 'meta']),
    ]);

    const result = listPageEvidence(subject, { tag: 'topic' });

    expect(result.pages.map((item) => item.slug)).toEqual(['a']);
  });

  it('allowedPageSlugs 在分页与 cursor 前过滤', () => {
    pages.getAllPages.mockReturnValue([
      page('a', 'A', '2026-01-01'), page('b', 'B', '2026-01-02'),
    ]);

    const result = listPageEvidence(
      subject,
      { limit: 1 },
      { allowedPageSlugs: new Set(['b']) },
    );

    expect(result.pages.map((item) => item.slug)).toEqual(['b']);
    expect(result.nextCursor).toBeNull();
  });

  it('cursor 与 tag 或 sort 不匹配时拒绝', () => {
    pages.getAllPages.mockReturnValue([
      page('a', 'A', '2026-01-01', ['x']), page('b', 'B', '2026-01-02', ['x']),
    ]);
    const first = listPageEvidence(subject, { limit: 1, tag: 'x', sort: 'title' });

    expect(() => listPageEvidence(subject, {
      cursor: first.nextCursor!, tag: 'y', sort: 'title',
    })).toThrow(/INVALID_CURSOR/);
    expect(() => listPageEvidence(subject, {
      cursor: first.nextCursor!, tag: 'x', sort: 'updated',
    })).toThrow(/INVALID_CURSOR/);
  });

  it('拒绝非 JSON、版本错误和字段缺失的 cursor', () => {
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    expect(() => listPageEvidence(subject, { cursor: 'not-json' }))
      .toThrow(/INVALID_CURSOR/);
    expect(() => listPageEvidence(subject, {
      cursor: encoded({ version: 2, sort: 'title', tag: null, lastValue: 'A', lastSlug: 'a' }),
    })).toThrow(/INVALID_CURSOR/);
    expect(() => listPageEvidence(subject, {
      cursor: encoded({ version: 1, sort: 'title', tag: null }),
    })).toThrow(/INVALID_CURSOR/);
  });

  it('默认 limit 为 50，reader 对过大 limit 截到 100', () => {
    pages.getAllPages.mockReturnValue(
      Array.from({ length: 105 }, (_, index) => page(
        `slug-${String(index).padStart(3, '0')}`,
        `Title ${String(index).padStart(3, '0')}`,
        '2026-01-01',
      )),
    );

    expect(listPageEvidence(subject).pages).toHaveLength(50);
    expect(listPageEvidence(subject, { limit: 500 }).pages).toHaveLength(100);
  });

  it('factory 将 subject 固定绑定到四类证据方法', () => {
    const reader = createSubjectEvidenceReader(subject);

    expect(Object.keys(reader).sort()).toEqual([
      'inspectPage', 'listPages', 'readSource', 'searchSources',
    ]);
  });
});
