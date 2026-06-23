import { describe, it, expect } from 'vitest';
import { countCallouts, nextMaturity, SPACING_LADDER } from '../maintenance-policy';

const NOW = new Date('2026-06-23T00:00:00.000Z');

describe('countCallouts', () => {
  it('计数六类 callout 首行，普通 blockquote 不计', () => {
    const md = [
      '> [!intuition] 💡 直觉',
      '> body',
      '',
      '> just a quote',
      '',
      '> [!example] 📝 例题',
    ].join('\n');
    expect(countCallouts(md)).toBe(2);
  });
});

describe('nextMaturity 递减回报', () => {
  it('零增量 + 已多遍 → 毕业（间隔置 0、状态 graduated）', () => {
    const r = nextMaturity({ state: 'active', passes: 3, intervalDays: 7, newIncrement: 0 }, NOW);
    expect(r.state).toBe('graduated');
    expect(r.intervalDays).toBe(0);
    expect(new Date(r.nextDueAt).getTime()).toBeGreaterThan(NOW.getTime() + 365 * 86_400_000); // 远期
  });

  it('零增量 + 遍数少 → 间隔快涨（阶梯 +2）不毕业', () => {
    const r = nextMaturity({ state: 'active', passes: 0, intervalDays: 1, newIncrement: 0 }, NOW);
    expect(r.state).toBe('active');
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 1 → +2 档 → 7
  });

  it('大量新增量 → 间隔慢涨（停在当前档，页还在长身体）', () => {
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 3, newIncrement: 5 }, NOW);
    expect(r.intervalDays).toBe(3); // 不前进
    expect(r.passes).toBe(2);
  });

  it('少量新增量 → 阶梯 +1', () => {
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 3, newIncrement: 1 }, NOW);
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 3 → 7
  });
});
