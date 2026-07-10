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
    for (const name of ['wiki.reenrich', 'wiki.create', 'wiki.update', 'wiki.patch', 'wiki.delete']) {
      expect(registry.get(name)?.description).not.toMatch(/confirm|prior turn/i);
    }
  });

  it('注册 Phase 1A 证据工具', () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.get('wiki.inspect')).toBeDefined();
    expect(registry.get('source.search')).toBeDefined();
    expect(registry.get('source.read')).toBeDefined();
  });
});
