import { describe, it, expect } from 'vitest';
import {
  jobActivityTitle,
  summarizeToolArgs,
  toolActivityIcon,
  toolActivityLine,
  toolActivityVerb,
} from '../tool-activity';

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

describe('tool-activity - wiki_patch', () => {
  it('图标/动词/参数摘要（slug）', () => {
    expect(toolActivityIcon('wiki_patch')).toBe('✏️');
    expect(toolActivityVerb('wiki_patch')).toBe('Patching');
    expect(summarizeToolArgs('wiki_patch', { slug: 'eigen' })).toBe('eigen');
    expect(summarizeToolArgs('wiki_patch', {})).toBe('');
  });
});

describe('tool-activity - narrow writes', () => {
  it('metadata 摘要只显示 slug 与字段名', () => {
    const args = { slug: 'page-a', title: '秘密标题', tags: ['秘密标签'] };
    expect(toolActivityIcon('wiki_metadata_patch')).toBe('✏️');
    expect(toolActivityVerb('wiki_metadata_patch')).toBe('Editing metadata');
    expect(summarizeToolArgs('wiki_metadata_patch', args)).toBe('page-a (title, tags)');
    expect(toolActivityLine('wiki_metadata_patch', args)).not.toContain('秘密');
  });

  it('link 摘要只显示 source/mode/target identity，不泄漏锚点', () => {
    const args = {
      sourceSlug: 'source', mode: 'retarget', targetSubjectSlug: 'other',
      targetSlug: 'target', oldString: '秘密上下文', displayText: '秘密锚点',
    };
    expect(toolActivityIcon('wiki_link_ensure')).toBe('🔗');
    expect(toolActivityVerb('wiki_link_ensure')).toBe('Maintaining link');
    expect(summarizeToolArgs('wiki_link_ensure', args))
      .toBe('source retarget other:target');
    expect(toolActivityLine('wiki_link_ensure', args)).not.toContain('秘密');
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

describe('jobActivityTitle', () => {
  it('识别 research-import 事件并优先于通用 Research', () => {
    expect(jobActivityTitle([{ type: 'research-import:start' }])).toBe('Importing research');
    expect(jobActivityTitle([{ type: 'research:start' }])).toBe('Researching');
  });

  it('保留 Ingest/Lint 与未知事件回退', () => {
    expect(jobActivityTitle([{ type: 'ingest:start' }])).toBe('Ingesting');
    expect(jobActivityTitle([{ type: 'lint:scope' }])).toBe('Linting');
    expect(jobActivityTitle([{ type: 'job:completed' }])).toBe('Processing');
  });
});
