import { describe, expect, it } from 'vitest';
import {
  citationHref,
  citationWikiLink,
  isWebCitation,
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
