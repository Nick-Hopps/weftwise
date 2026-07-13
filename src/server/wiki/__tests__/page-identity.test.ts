import { describe, it, expect } from 'vitest';
import { deriveUniqueSlug, isCanonicalPageSlug } from '../page-identity';

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

describe('isCanonicalPageSlug', () => {
  it('接受规范单段与嵌套 slug', () => {
    expect(isCanonicalPageSlug('page-a')).toBe(true);
    expect(isCanonicalPageSlug('folder/nested-page')).toBe(true);
    expect(isCanonicalPageSlug('中文/页面-2')).toBe(true);
  });

  it.each([
    '', '../other/page', '../other/index', '/absolute', 'nested//page',
    'nested\\page', ' Page ', 'UPPER', 'page_name', 'page!',
  ])('拒绝非规范或越界 slug：%s', (slug) => {
    expect(isCanonicalPageSlug(slug)).toBe(false);
  });
});
