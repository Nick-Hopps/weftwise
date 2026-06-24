import { describe, it, expect } from 'vitest';
import { buildTitleSlugMap } from '../title-slug-map';

describe('buildTitleSlugMap', () => {
  it('同时映射原标题与小写标题到 slug', () => {
    const map = buildTitleSlugMap([{ title: 'Linear Algebra', slug: 'linear-algebra' }]);
    expect(map['Linear Algebra']).toBe('linear-algebra');
    expect(map['linear algebra']).toBe('linear-algebra');
  });

  it('空输入返回空对象', () => {
    expect(buildTitleSlugMap([])).toEqual({});
  });

  it('同名标题后者覆盖前者', () => {
    const map = buildTitleSlugMap([
      { title: 'Dup', slug: 'dup-1' },
      { title: 'Dup', slug: 'dup-2' },
    ]);
    expect(map['Dup']).toBe('dup-2');
  });
});
