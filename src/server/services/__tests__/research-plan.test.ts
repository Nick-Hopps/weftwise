import { describe, it, expect } from 'vitest';
import {
  dedupeQueries,
  normalizeUrl,
  dedupeCandidates,
  applyTriage,
  fallbackTriage,
  defaultChecked,
  MAX_QUERIES,
  MAX_CANDIDATES,
  MAX_RESULTS,
} from '../research-plan';

describe('dedupeQueries', () => {
  it('去除大小写/空白重复并保序', () => {
    expect(dedupeQueries(['Rust async', ' rust async ', 'Tokio runtime'])).toEqual([
      'Rust async',
      'Tokio runtime',
    ]);
  });

  it('过滤空字符串', () => {
    expect(dedupeQueries(['', '  ', 'x'])).toEqual(['x']);
  });

  it('截断到上限（默认 3）', () => {
    const qs = ['a', 'b', 'c', 'd', 'e'];
    expect(dedupeQueries(qs)).toEqual(['a', 'b', 'c']);
    expect(dedupeQueries(qs).length).toBeLessThanOrEqual(MAX_QUERIES);
  });

  it('支持自定义上限', () => {
    expect(dedupeQueries(['a', 'b', 'c'], 1)).toEqual(['a']);
  });
});

describe('normalizeUrl', () => {
  it('去掉 trailing slash 与 hash，host 小写', () => {
    expect(normalizeUrl('https://Example.com/foo/#section')).toBe('https://example.com/foo');
  });

  it('保留 query string（不同 query 视为不同资源）', () => {
    expect(normalizeUrl('https://a.com/x?y=1')).toBe('https://a.com/x?y=1');
  });

  it('非法 URL 兜底 trim', () => {
    expect(normalizeUrl('not a url/')).toBe('not a url');
  });
});

describe('dedupeCandidates', () => {
  const mk = (url: string) => ({ url, title: url, snippet: '' });

  it('按归一化 URL 去重，保留先到先得顺序', () => {
    const out = dedupeCandidates([mk('https://a.com/x/'), mk('https://a.com/x'), mk('https://b.com/y')]);
    expect(out.map((c) => c.url)).toEqual(['https://a.com/x/', 'https://b.com/y']);
  });

  it('过滤空 url', () => {
    expect(dedupeCandidates([{ url: '', title: '', snippet: '' }])).toEqual([]);
  });

  it('截断到上限（默认 12）', () => {
    const many = Array.from({ length: 20 }, (_, i) => mk(`https://x.com/${i}`));
    const out = dedupeCandidates(many);
    expect(out.length).toBe(MAX_CANDIDATES);
  });
});

describe('applyTriage', () => {
  const candidates = [
    { url: 'https://a.com', title: 'A', snippet: 'a' },
    { url: 'https://b.com', title: 'B', snippet: 'b' },
    { url: 'https://c.com', title: 'C', snippet: 'c' },
  ];

  it('score >= 2 保留，按 score 降序', () => {
    const out = applyTriage(candidates, [
      { url: 'https://a.com', score: 1, reason: 'weak' },
      { url: 'https://b.com', score: 3, reason: 'great' },
      { url: 'https://c.com', score: 2, reason: 'ok' },
    ]);
    expect(out.map((c) => c.url)).toEqual(['https://b.com', 'https://c.com']);
    expect(out[0].score).toBe(3);
  });

  it('未出现在 triage 结果中的候选视为 score 0 被过滤', () => {
    const out = applyTriage(candidates, [{ url: 'https://a.com', score: 3, reason: 'x' }]);
    expect(out.map((c) => c.url)).toEqual(['https://a.com']);
  });

  it('截断到上限（默认 6）', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ url: `https://x.com/${i}`, title: '', snippet: '' }));
    const triage = many.map((c) => ({ url: c.url, score: 3, reason: 'ok' }));
    const out = applyTriage(many, triage);
    expect(out.length).toBe(MAX_RESULTS);
  });
});

describe('fallbackTriage', () => {
  it('按原始排名取前 3，score 为 null', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({ url: `https://x.com/${i}`, title: '', snippet: '' }));
    const out = fallbackTriage(candidates);
    expect(out.length).toBe(3);
    expect(out.every((c) => c.score === null && c.reason === null)).toBe(true);
    expect(out.map((c) => c.url)).toEqual(['https://x.com/0', 'https://x.com/1', 'https://x.com/2']);
  });
});

describe('defaultChecked', () => {
  it('score === 3 才默认勾选', () => {
    expect(defaultChecked({ url: '', title: '', snippet: '', score: 3, reason: null })).toBe(true);
    expect(defaultChecked({ url: '', title: '', snippet: '', score: 2, reason: null })).toBe(false);
    expect(defaultChecked({ url: '', title: '', snippet: '', score: null, reason: null })).toBe(false);
  });
});
