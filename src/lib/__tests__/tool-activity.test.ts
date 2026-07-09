import { describe, it, expect } from 'vitest';
import { toolActivityIcon, toolActivityVerb, summarizeToolArgs, toolActivityLine } from '../tool-activity';

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

describe('tool-activity - web_search', () => {
  it('图标/动词/参数摘要', () => {
    expect(toolActivityIcon('web_search')).toBe('🌐');
    expect(toolActivityVerb('web_search')).toBe('Searching the web');
    expect(summarizeToolArgs('web_search', { query: 'foo' })).toBe('foo');
  });
});

describe('toolActivityLine', () => {
  it('拼装 icon + verb + 参数摘要', () => {
    expect(toolActivityLine('wiki_read', { slug: 'some-page' })).toBe('📄 Reading "some-page"…');
    expect(toolActivityLine('wiki_search', { query: 'panda diet' })).toBe('🔍 Searching "panda diet"…');
    expect(toolActivityLine('wiki_merge', { sourceSlug: 'a', targetSlug: 'b' })).toBe('🔗 Merging "a → b"…');
  });

  it('无参数摘要时省略引号段', () => {
    expect(toolActivityLine('wiki_list', {})).toBe('🗂 Listing pages…');
  });

  it('未知工具回落工具名', () => {
    expect(toolActivityLine('mystery_tool', { x: 1 })).toBe('• mystery_tool…');
  });
});
