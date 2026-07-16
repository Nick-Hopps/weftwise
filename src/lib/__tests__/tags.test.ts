import { describe, it, expect } from 'vitest';
import {
  filterPagesByTags,
  filterTagSummaries,
  findPotentialDuplicateGroups,
  relatedTags,
  sortTagSummaries,
  summarizeTags,
  tagStats,
  META_TAG,
} from '../tags';
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

describe('标签目录分析', () => {
  it('汇总覆盖率、最近更新时间与目录统计', () => {
    const pages = [
      { ...page('a', ['math', 'algebra']), updatedAt: '2026-01-02' },
      { ...page('b', ['math']), updatedAt: '2026-01-03' },
      page('c', []),
      page('index', [META_TAG]),
    ];
    const summaries = summarizeTags(pages);

    expect(summaries.map(({ tag, count, coverage, updatedAt }) => ({
      tag, count, coverage, updatedAt,
    }))).toEqual([
      { tag: 'math', count: 2, coverage: 2 / 3, updatedAt: '2026-01-03' },
      { tag: 'algebra', count: 1, coverage: 1 / 3, updatedAt: '2026-01-02' },
    ]);
    expect(tagStats(pages, summaries)).toEqual({
      pageCount: 3,
      taggedPageCount: 2,
      tagCount: 2,
      singletonCount: 1,
      duplicateGroups: [],
    });
  });

  it('排除带 meta 标签的系统页及 meta 标签本身', () => {
    const summaries = summarizeTags([
      page('log', [META_TAG, 'overview']),
      page('visible', ['overview']),
    ]);

    expect(summaries.map(({ tag, count }) => ({ tag, count }))).toEqual([
      { tag: 'overview', count: 1 },
    ]);
  });

  it('搜索标签名称与关联页面文本，并支持三种排序', () => {
    const pages = [
      { ...page('matrix', ['linear-algebra']), title: 'Matrix methods', summary: 'Eigenvalues', updatedAt: '2026-01-02' },
      { ...page('shader', ['rendering']), title: 'Shader notes', summary: 'GPU', updatedAt: '2026-01-04' },
      { ...page('pipeline', ['rendering']), title: 'Render pipeline', updatedAt: '2026-01-03' },
    ];
    const summaries = summarizeTags(pages);

    expect(filterTagSummaries(summaries, 'eigen').map((item) => item.tag)).toEqual(['linear-algebra']);
    expect(sortTagSummaries(summaries, 'name').map((item) => item.tag)).toEqual(['linear-algebra', 'rendering']);
    expect(sortTagSummaries(summaries, 'recent').map((item) => item.tag)).toEqual(['rendering', 'linear-algebra']);
  });

  it('识别仅格式不同的潜在重复标签', () => {
    const groups = findPotentialDuplicateGroups([
      { tag: 'Game Design' },
      { tag: 'game-design' },
      { tag: 'game_design' },
      { tag: 'shader' },
    ]);

    expect(groups).toHaveLength(1);
    expect(new Set(groups[0])).toEqual(new Set(['Game Design', 'game-design', 'game_design']));
  });
});

describe('组合标签浏览', () => {
  const pages = [
    { ...page('a', ['rendering', 'shader']), title: 'Alpha', updatedAt: '2026-01-02' },
    { ...page('b', ['rendering', 'pipeline']), title: 'Beta', summary: 'Shader pipeline', updatedAt: '2026-01-04' },
    { ...page('c', ['shader']), title: 'Gamma', updatedAt: '2026-01-03' },
    page('index', [META_TAG, 'rendering']),
  ];

  it('支持 AND/OR、文本过滤与两种排序，并排除系统页', () => {
    expect(filterPagesByTags(pages, ['rendering', 'shader'], 'and').map((item) => item.slug)).toEqual(['a']);
    expect(filterPagesByTags(pages, ['rendering', 'shader'], 'or').map((item) => item.slug)).toEqual(['b', 'c', 'a']);
    expect(filterPagesByTags(pages, ['rendering'], 'and', 'shader').map((item) => item.slug)).toEqual(['b']);
    expect(filterPagesByTags(pages, ['shader'], 'and', '', 'title').map((item) => item.slug)).toEqual(['a', 'c']);
  });

  it('保持标签原样匹配，不静默合并大小写', () => {
    expect(filterPagesByTags([page('a', ['Math'])], ['math'])).toEqual([]);
  });

  it('按当前结果集计算相关标签', () => {
    expect(relatedTags(pages, ['rendering'])).toEqual([
      { tag: 'pipeline', count: 1 },
      { tag: 'shader', count: 1 },
    ]);
    expect(relatedTags(pages, ['rendering', 'shader'], 'and')).toEqual([]);
  });
});
