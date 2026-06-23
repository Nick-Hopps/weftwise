import { describe, it, expect } from 'vitest';
import { shouldSweep } from '../worker';

const NOW = new Date('2026-06-23T12:00:00.000Z');

describe('shouldSweep', () => {
  it('从未扫描 → 应扫', () => {
    expect(shouldSweep(null, 24, NOW)).toBe(true);
  });
  it('距上次不足节律 → 不扫', () => {
    const last = new Date(NOW.getTime() - 3 * 3600_000).toISOString(); // 3h 前
    expect(shouldSweep(last, 24, NOW)).toBe(false);
  });
  it('距上次超过节律 → 应扫', () => {
    const last = new Date(NOW.getTime() - 25 * 3600_000).toISOString(); // 25h 前
    expect(shouldSweep(last, 24, NOW)).toBe(true);
  });
  it('恰好等于节律（>= 边界）→ 应扫', () => {
    const last = new Date(NOW.getTime() - 24 * 3600_000).toISOString(); // 精确 24h 前
    expect(shouldSweep(last, 24, NOW)).toBe(true);
  });
});
