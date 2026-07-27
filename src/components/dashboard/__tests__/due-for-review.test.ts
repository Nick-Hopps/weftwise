import { describe, it, expect } from 'vitest';
import { overdueDays } from '../due-for-review';

const NOW = new Date('2026-07-27T12:00:00.000Z');
const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();

describe('overdueDays', () => {
  it('当天到期算 0（节律内，还没开始遗忘）', () => {
    expect(overdueDays(ago(0), NOW)).toBe(0);
    expect(overdueDays(ago(0.9), NOW)).toBe(0);
  });

  it('下取整到整天：间隔重复的最小档位就是 1 天，小时级精度没有意义', () => {
    expect(overdueDays(ago(1), NOW)).toBe(1);
    expect(overdueDays(ago(1.9), NOW)).toBe(1);
    expect(overdueDays(ago(9.5), NOW)).toBe(9);
  });

  it('尚未到期（未来时刻）钳制为 0，不出现负数天', () => {
    expect(overdueDays(ago(-3), NOW)).toBe(0);
  });
});
