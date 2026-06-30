import { describe, it, expect } from 'vitest';
import { isRememberablePath, withSubjectParam } from '../subject-nav';

describe('isRememberablePath', () => {
  it('wiki / sources 子路径可记忆', () => {
    expect(isRememberablePath('/wiki/foo')).toBe(true);
    expect(isRememberablePath('/wiki/a/b')).toBe(true);
    expect(isRememberablePath('/sources/abc')).toBe(true);
  });

  it('裸前缀与全局路由不可记忆', () => {
    for (const p of ['/', '/wiki', '/sources', '/tags', '/tags/x', '/health', '/history', '/subjects', '/ingest', '']) {
      expect(isRememberablePath(p)).toBe(false);
    }
  });
});

describe('withSubjectParam', () => {
  it('无 query 时追加 s', () => {
    expect(withSubjectParam('/wiki/foo', 'frontend')).toBe('/wiki/foo?s=frontend');
  });

  it('丢弃旧 s、保留其余 query、s 追加到末尾', () => {
    expect(withSubjectParam('/wiki/foo?s=old&x=1', 'frontend')).toBe('/wiki/foo?x=1&s=frontend');
  });

  it('保留其他 query', () => {
    expect(withSubjectParam('/wiki/foo?x=1', 'b')).toBe('/wiki/foo?x=1&s=b');
  });

  it('保留 hash', () => {
    expect(withSubjectParam('/wiki/foo#sec', 'b')).toBe('/wiki/foo?s=b#sec');
  });
});
