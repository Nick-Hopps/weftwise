import { describe, expect, it } from 'vitest';
import { formatTokenCount } from '../format';

describe('formatTokenCount', () => {
  it('小于 1000 原样显示', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });
  it('千级带 k、保留一位小数（整数则省略）', () => {
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(12345)).toBe('12.3k');
    expect(formatTokenCount(999_949)).toBe('999.9k');
  });
  it('百万级带 M', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_234_567)).toBe('1.2M');
  });
  it('非法输入回落 0', () => {
    expect(formatTokenCount(NaN)).toBe('0');
    expect(formatTokenCount(-5)).toBe('0');
  });
});
