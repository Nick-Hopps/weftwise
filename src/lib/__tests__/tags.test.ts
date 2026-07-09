import { describe, it, expect } from 'vitest';
import {
  aggregateTags,
  pagesWithTag,
  tagCloudWeights,
  shuffleTagsDeterministic,
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
    expect(aggregateTags(pages)).toEqual([{ tag: 'math', count: 1 }]);
  });

  it('排除带 meta 标签的系统页（按 tags 判定，与 slug 无关）', () => {
    const pages = [page('log', [META_TAG, 'overview']), page('b', ['overview'])];
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

  it('排除带 meta 的系统页（slug 非 index 亦然）', () => {
    const pages = [page('log', [META_TAG, 'math']), page('a', ['math'])];
    expect(pagesWithTag(pages, 'math').map((p) => p.slug)).toEqual(['a']);
  });

  it('区分大小写；未知 tag 返回 []', () => {
    const pages = [page('a', ['Math'])];
    expect(pagesWithTag(pages, 'math')).toEqual([]);
    expect(pagesWithTag(pages, 'nope')).toEqual([]);
  });
});

describe('tagCloudWeights', () => {
  it('空输入返回 []', () => {
    expect(tagCloudWeights([])).toEqual([]);
  });

  it('单 tag 或全同 count 时 weight 全为 0.5', () => {
    expect(tagCloudWeights([{ tag: 'a', count: 3 }])[0].weight).toBe(0.5);
    const same = tagCloudWeights([
      { tag: 'a', count: 2 },
      { tag: 'b', count: 2 },
    ]);
    expect(same.map((t) => t.weight)).toEqual([0.5, 0.5]);
  });

  it('min 得 0、max 得 1，中间值经 log 平滑落在 (0,1)', () => {
    const out = tagCloudWeights([
      { tag: 'min', count: 1 },
      { tag: 'mid', count: 10 },
      { tag: 'max', count: 100 },
    ]);
    const byTag = Object.fromEntries(out.map((t) => [t.tag, t.weight]));
    expect(byTag.min).toBe(0);
    expect(byTag.max).toBe(1);
    expect(byTag.mid).toBeCloseTo(0.5, 5); // log 空间正中
  });

  it('极端偏斜分布下低频 tag 仍有区分度（log 平滑）', () => {
    const out = tagCloudWeights([
      { tag: 'a', count: 1 },
      { tag: 'b', count: 2 },
      { tag: 'hot', count: 1000 },
    ]);
    const byTag = Object.fromEntries(out.map((t) => [t.tag, t.weight]));
    expect(byTag.b).toBeGreaterThan(0.05); // 线性归一化时 b≈0.001，log 后明显更大
  });
});

describe('shuffleTagsDeterministic', () => {
  it('两次调用结果一致且元素不丢', () => {
    const input = [{ tag: 'a' }, { tag: 'b' }, { tag: 'c' }, { tag: 'd' }];
    const once = shuffleTagsDeterministic(input);
    expect(shuffleTagsDeterministic(input)).toEqual(once);
    expect([...once].map((t) => t.tag).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('不修改输入数组', () => {
    const input = [{ tag: 'b' }, { tag: 'a' }];
    const snapshot = [...input];
    shuffleTagsDeterministic(input);
    expect(input).toEqual(snapshot);
  });
});
