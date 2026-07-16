import { describe, expect, it } from 'vitest';
import { getActiveHeadingId } from '@/components/wiki/article-toc';

describe('getActiveHeadingId', () => {
  const positions = [
    { id: 'first', top: 140 },
    { id: 'second', top: 520 },
    { id: 'third', top: 900 },
  ];

  it('判定线尚未经过首个标题时仍指向第一节', () => {
    expect(getActiveHeadingId(positions, 80)).toBe('first');
  });

  it('返回最后一个越过判定线的标题', () => {
    expect(getActiveHeadingId(positions, 600)).toBe('second');
    expect(getActiveHeadingId(positions, 1200)).toBe('third');
  });

  it('没有标题时返回 null', () => {
    expect(getActiveHeadingId([], 80)).toBeNull();
  });
});
