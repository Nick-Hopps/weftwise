import { describe, expect, it } from 'vitest';
import {
  citationHref,
  citationWikiLink,
  isWebCitation,
  normalizeCitationUrl,
  splitAnswerCitations,
} from '../wiki-citation';

describe('wiki citation', () => {
  it('旧引用保持当前 Subject 路径和无前缀 wikilink', () => {
    const citation = { pageSlug: 'sqlite', excerpt: 'x' };
    expect(citationHref(citation)).toBe('/wiki/sqlite');
    expect(citationWikiLink(citation, 'general')).toBe('[[sqlite]]');
  });

  it('跨主题引用跳转与保存正文都保留 Subject slug', () => {
    const citation = { pageSlug: 'sqlite', excerpt: 'x', subjectSlug: 'db-notes' };
    expect(citationHref(citation)).toBe('/wiki/sqlite?s=db-notes');
    expect(citationWikiLink(citation, 'general')).toBe('[[db-notes:sqlite]]');
  });

  it('显式 active Subject 不重复写前缀', () => {
    const citation = { pageSlug: 'sqlite', excerpt: 'x', subjectSlug: 'general' };
    expect(citationWikiLink(citation, 'general')).toBe('[[sqlite]]');
  });
});

describe('normalizeCitationUrl', () => {
  it('统一 host 大小写、去 fragment、去路径末尾斜杠', () => {
    expect(normalizeCitationUrl('https://SQLite.org/wal.html/')).toBe('https://sqlite.org/wal.html');
    expect(normalizeCitationUrl('https://example.com/a?x=1#frag')).toBe('https://example.com/a?x=1');
    expect(normalizeCitationUrl('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it('origin 根保留单个斜杠，两种写法归一到同一把尺子', () => {
    expect(normalizeCitationUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeCitationUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('剥掉散文/markdown 粘上的尾部标点与收尾括号', () => {
    expect(normalizeCitationUrl('https://example.com/a。')).toBe('https://example.com/a');
    expect(normalizeCitationUrl('https://example.com/a),')).toBe('https://example.com/a');
    expect(normalizeCitationUrl('https://example.com/a>')).toBe('https://example.com/a');
  });

  it('配平的括号是 URL 的一部分，不能剥', () => {
    expect(normalizeCitationUrl('https://en.wikipedia.org/wiki/Foo_(bar)'))
      .toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    // markdown 链接 `](…)` 扫出来会多带一个收尾括号，只该剥那一个
    expect(normalizeCitationUrl('https://en.wikipedia.org/wiki/Foo_(bar))'))
      .toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('非 http(s) 与非字符串返回 null', () => {
    expect(normalizeCitationUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeCitationUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeCitationUrl('not a url')).toBeNull();
    expect(normalizeCitationUrl('')).toBeNull();
    expect(normalizeCitationUrl(null)).toBeNull();
    expect(normalizeCitationUrl(42)).toBeNull();
  });
});

describe('isWebCitation', () => {
  it('按非空 url 字段判别', () => {
    expect(isWebCitation({ url: 'https://example.com', title: 'Example' })).toBe(true);
    expect(isWebCitation({ pageSlug: 'sqlite', excerpt: 'x' })).toBe(false);
  });
});

describe('splitAnswerCitations', () => {
  it('存量形状（只有 pageSlug/excerpt）全部归 wiki', () => {
    const stored = [
      { pageSlug: 'a', excerpt: 'x' },
      { pageSlug: 'b', excerpt: 'y', subjectSlug: 'other' },
    ];

    expect(splitAnswerCitations(stored)).toEqual({ wiki: stored, web: [] });
  });

  it('混合数组按字段拆分且各自保序', () => {
    const { wiki, web } = splitAnswerCitations([
      { pageSlug: 'a', excerpt: 'x' },
      { url: 'https://one.example', title: 'One' },
      { pageSlug: 'b', excerpt: 'y' },
      { url: 'https://two.example', title: 'Two' },
    ]);

    expect(wiki.map((c) => c.pageSlug)).toEqual(['a', 'b']);
    expect(web.map((c) => c.url)).toEqual(['https://one.example', 'https://two.example']);
  });

  it('丢弃脏数据，不进任一侧', () => {
    const { wiki, web } = splitAnswerCitations([
      null,
      'nope',
      42,
      {},
      { url: '', title: 'empty url' },
      { pageSlug: '', excerpt: 'empty slug' },
      { excerpt: 'no identity' },
    ]);

    expect(wiki).toEqual([]);
    expect(web).toEqual([]);
  });

  it('非数组输入返回空双侧', () => {
    expect(splitAnswerCitations(null)).toEqual({ wiki: [], web: [] });
    expect(splitAnswerCitations(undefined)).toEqual({ wiki: [], web: [] });
    expect(splitAnswerCitations({ pageSlug: 'a', excerpt: 'x' })).toEqual({ wiki: [], web: [] });
  });

  it('web 条目缺 title 时回退 url，不丢条目', () => {
    expect(splitAnswerCitations([{ url: 'https://one.example' }]).web)
      .toEqual([{ url: 'https://one.example', title: 'https://one.example' }]);
  });

  it('wiki 条目缺 excerpt 时补空串，不丢条目', () => {
    expect(splitAnswerCitations([{ pageSlug: 'a' }]).wiki)
      .toEqual([{ pageSlug: 'a', excerpt: '' }]);
  });
});
