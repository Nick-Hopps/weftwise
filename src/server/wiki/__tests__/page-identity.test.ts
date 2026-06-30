import { describe, it, expect } from 'vitest';
import { deriveUniqueSlug } from '../page-identity';

describe('deriveUniqueSlug', () => {
  it('无冲突 → base slug', () => {
    expect(deriveUniqueSlug('Eigen Values', new Set())).toBe('eigen-values');
  });
  it('冲突 → 追加 -2 / -3', () => {
    expect(deriveUniqueSlug('Foo', new Set(['foo']))).toBe('foo-2');
    expect(deriveUniqueSlug('Foo', new Set(['foo', 'foo-2']))).toBe('foo-3');
  });
  it('空白标题 → page 兜底', () => {
    expect(deriveUniqueSlug('   ', new Set())).toBe('page');
  });
  it('接受数组形式 taken', () => {
    expect(deriveUniqueSlug('Foo', ['foo'])).toBe('foo-2');
  });
});
