import { describe, expect, it } from 'vitest';
import { createBuiltinToolRegistry } from '..';

describe('createBuiltinToolRegistry', () => {
  it('不注册不可达的 dispatch 与通用提交工具', () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.get('dispatch.skill')).toBeUndefined();
    expect(registry.get('commit_changeset')).toBeUndefined();
  });

  it('共享写工具描述不包含 Query 专属的口头确认授权', () => {
    const registry = createBuiltinToolRegistry();
    for (const name of [
      'wiki.reenrich', 'wiki.create', 'wiki.update', 'wiki.patch', 'wiki.delete',
      'wiki.metadata.patch', 'wiki.link.ensure',
    ]) {
      expect(registry.get(name)?.description).not.toMatch(/confirm|prior turn/i);
    }
  });

  it('注册 Phase 1A 证据工具', () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.get('wiki.inspect')).toBeDefined();
    expect(registry.get('source.search')).toBeDefined();
    expect(registry.get('source.read')).toBeDefined();
  });

  it('注册两个 Phase 2B 窄写工具', () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.get('wiki.metadata.patch')).toBeDefined();
    expect(registry.get('wiki.link.ensure')).toBeDefined();
  });

  it('注册 Phase 3A 跨主题只读工具', () => {
    const registry = createBuiltinToolRegistry();
    for (const name of [
      'subject.list',
      'wiki.search_cross_subject',
      'wiki.read_cross_subject',
    ]) {
      expect(registry.get(name)).toMatchObject({ sideEffect: 'none' });
    }
  });

  it('注册 Phase 3B History 工具并保持回滚为提案副作用', () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.get('history.list')).toMatchObject({ sideEffect: 'none' });
    expect(registry.get('history.diff')).toMatchObject({ sideEffect: 'none' });
    expect(registry.get('history.revert')).toMatchObject({ sideEffect: 'propose' });
  });

  it('注册 Phase 3C 工作流控制工具并保持启动取消为提案副作用', () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.resolve(['*'])).toHaveLength(30);
    expect(registry.get('workflow.status')).toMatchObject({ sideEffect: 'none' });
    expect(registry.get('workflow.reenrich.start')).toMatchObject({ sideEffect: 'propose' });
    expect(registry.get('workflow.research.start')).toMatchObject({ sideEffect: 'propose' });
    expect(registry.get('workflow.cancel')).toMatchObject({ sideEffect: 'propose' });
    expect(registry.get('wiki.reenrich')).toMatchObject({ sideEffect: 'propose' });
  });

  it('注册 enrich 专用图片生图工具且不产生写副作用', () => {
    expect(createBuiltinToolRegistry().get('image.generate')).toMatchObject({
      sideEffect: 'none',
    });
  });

  it('注册 Ask AI 选区配图提案工具且不开放真实生图副作用', () => {
    expect(createBuiltinToolRegistry().get('wiki.image.insert')).toMatchObject({
      sideEffect: 'propose',
    });
  });

  it('注册 Phase 3D wiki.move 且只暴露提案副作用', () => {
    expect(createBuiltinToolRegistry().get('wiki.move')).toMatchObject({
      sideEffect: 'propose',
    });
  });
});
