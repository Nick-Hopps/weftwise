import { describe, expect, it } from 'vitest';
import { calculateReadingProgress } from '@/components/wiki/reading-progress';

describe('calculateReadingProgress', () => {
  it('maps the scrollable range to zero through one hundred percent', () => {
    expect(calculateReadingProgress(0, 2000, 1000)).toBe(0);
    expect(calculateReadingProgress(500, 2000, 1000)).toBe(50);
    expect(calculateReadingProgress(1000, 2000, 1000)).toBe(100);
  });

  it('clamps overscroll and treats short pages as complete', () => {
    expect(calculateReadingProgress(-20, 2000, 1000)).toBe(0);
    expect(calculateReadingProgress(1200, 2000, 1000)).toBe(100);
    expect(calculateReadingProgress(0, 800, 1000)).toBe(100);
  });
});
