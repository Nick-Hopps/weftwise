import { describe, it, expect } from 'vitest';
import { toolActivityIcon, toolActivityVerb, summarizeToolArgs } from '../tool-activity';

describe('tool-activity', () => {
  it('已知工具映射 icon/verb（含 wiki_reenrich）', () => {
    expect(toolActivityIcon('wiki_reenrich')).toBe('✨');
    expect(toolActivityVerb('wiki_reenrich')).toBe('Re-enriching');
    expect(toolActivityIcon('wiki_search')).toBe('🔍');
    expect(toolActivityVerb('wiki_read')).toBe('Reading');
    expect(toolActivityIcon('wiki_list')).toBe('🗂');
  });
  it('未知工具回落', () => {
    expect(toolActivityIcon('mystery')).toBe('•');
    expect(toolActivityVerb('mystery')).toBe('mystery');
  });
  it('summarizeToolArgs：search→query，read/reenrich→slug，其它空', () => {
    expect(summarizeToolArgs('wiki_search', { query: 'foo' })).toBe('foo');
    expect(summarizeToolArgs('wiki_read', { slug: 'bar' })).toBe('bar');
    expect(summarizeToolArgs('wiki_reenrich', { slug: 'baz' })).toBe('baz');
    expect(summarizeToolArgs('wiki_list', {})).toBe('');
    expect(summarizeToolArgs('wiki_search', null)).toBe('');
  });
});

describe('tool-activity - wiki_create/wiki_delete', () => {
  it('图标', () => {
    expect(toolActivityIcon('wiki_create')).toBe('➕');
    expect(toolActivityIcon('wiki_delete')).toBe('🗑');
  });
  it('动词', () => {
    expect(toolActivityVerb('wiki_create')).toBe('Creating');
    expect(toolActivityVerb('wiki_delete')).toBe('Deleting');
  });
  it('参数摘要：create 取 title，delete 取 slug', () => {
    expect(summarizeToolArgs('wiki_create', { title: 'Foo' })).toBe('Foo');
    expect(summarizeToolArgs('wiki_delete', { slug: 'eigen' })).toBe('eigen');
  });
});

describe('tool-activity - wiki_merge/wiki_split', () => {
  it('图标', () => {
    expect(toolActivityIcon('wiki_merge')).toBe('🔗');
    expect(toolActivityIcon('wiki_split')).toBe('✂️');
  });
  it('动词', () => {
    expect(toolActivityVerb('wiki_merge')).toBe('Merging');
    expect(toolActivityVerb('wiki_split')).toBe('Splitting');
  });
  it('参数摘要：merge=source→target，split=slug', () => {
    expect(summarizeToolArgs('wiki_merge', { targetSlug: 'a', sourceSlug: 'b' })).toBe('b → a');
    expect(summarizeToolArgs('wiki_split', { slug: 'a' })).toBe('a');
  });
});
