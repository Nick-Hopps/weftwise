import { describe, expect, it } from 'vitest';
import { displayTitleForSlug } from '@/lib/path-display';

describe('displayTitleForSlug', () => {
  it('优先展示页面元数据中的标题', () => {
    expect(
      displayTitleForSlug('3d%E5%9B%BE%E5%BD%A2%E5%AD%A6%E5%9F%BA%E7%A1%80', [
        { slug: '3d图形学基础', title: '自定义标题' },
      ]),
    ).toBe('自定义标题');
  });

  it('页面未命中时解码中文 slug', () => {
    expect(displayTitleForSlug('3d%E5%9B%BE%E5%BD%A2%E5%AD%A6%E5%9F%BA%E7%A1%80')).toBe(
      '3d图形学基础',
    );
  });

  it('遇到畸形 URL 编码时保留原始 slug', () => {
    expect(displayTitleForSlug('broken%E5%A')).toBe('broken%E5%A');
  });
});
