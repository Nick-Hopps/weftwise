import { describe, expect, it } from 'vitest';
import { createBuiltinToolRegistry } from '..';

describe('createBuiltinToolRegistry', () => {
  it('不注册不可达的 dispatch 与通用提交工具', () => {
    const registry = createBuiltinToolRegistry();
    expect(registry.get('dispatch.skill')).toBeUndefined();
    expect(registry.get('commit_changeset')).toBeUndefined();
  });
});
