import { describe, expect, it } from 'vitest';
import { citationHref, citationWikiLink } from '../wiki-citation';

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
