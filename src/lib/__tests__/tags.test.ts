import { describe, it, expect } from 'vitest';
import { aggregateTags, pagesWithTag, META_TAG } from '../tags';
import type { WikiPage } from '@/lib/contracts';

function page(slug: string, tags: string[]): WikiPage {
  return {
    slug,
    title: slug,
    path: `wiki/general/${slug}.md`,
    summary: '',
    contentHash: 'h',
    tags,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    subjectId: 's1',
  };
}

describe('aggregateTags', () => {
  it('计数并按 count 降序、同 count 字母升序', () => {
    const pages = [
      page('a', ['math', 'algebra']),
      page('b', ['math']),
      page('c', ['algebra']),
      page('d', ['zzz']),
    ];
    // math:2, algebra:2, zzz:1 → 同 count 字母序 algebra 在 math 前
    expect(aggregateTags(pages)).toEqual([
      { tag: 'algebra', count: 2 },
      { tag: 'math', count: 2 },
      { tag: 'zzz', count: 1 },
    ]);
  });

  it('排除 meta 标签本身', () => {
    const pages = [page('a', ['math', META_TAG]), page('b', ['math'])];
    expect(aggregateTags(pages)).toEqual([{ tag: 'math', count: 2 }]);
  });

  it('排除带 meta 标签的系统页（其所有标签都不计入）', () => {
    const pages = [page('index', [META_TAG, 'overview']), page('b', ['overview'])];
    expect(aggregateTags(pages)).toEqual([{ tag: 'overview', count: 1 }]);
  });

  it('空输入返回 []', () => {
    expect(aggregateTags([])).toEqual([]);
  });
});

describe('pagesWithTag', () => {
  it('返回含该 tag 的内容页', () => {
    const pages = [page('a', ['math']), page('b', ['algebra']), page('c', ['math', 'algebra'])];
    expect(pagesWithTag(pages, 'math').map((p) => p.slug)).toEqual(['a', 'c']);
  });

  it('排除带 meta 的系统页', () => {
    const pages = [page('index', [META_TAG, 'math']), page('a', ['math'])];
    expect(pagesWithTag(pages, 'math').map((p) => p.slug)).toEqual(['a']);
  });

  it('区分大小写；未知 tag 返回 []', () => {
    const pages = [page('a', ['Math'])];
    expect(pagesWithTag(pages, 'math')).toEqual([]);
    expect(pagesWithTag(pages, 'nope')).toEqual([]);
  });
});
