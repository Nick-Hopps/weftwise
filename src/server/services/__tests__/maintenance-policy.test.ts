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

  it('阶梯顶端（60d）+1 不超出最大档，间隔钳制在 60', () => {
    // ladderIndex(60)=4，step=1（少量新增），ni=Math.min(4,5)=4 → SPACING_LADDER[4]=60
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 60, newIncrement: 1 }, NOW);
    expect(r.intervalDays).toBe(60);
    expect(r.state).toBe('active');
  });

  it('零增量 + passes 将变为 2（<3）→ 仍 active，间隔 +2 档', () => {
    // passes=1+1=2 < GRADUATE_AFTER_PASSES(3) → 不毕业
    // ladderIndex(7)=2，ni=Math.min(4,2+2)=4 → SPACING_LADDER[4]=60
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 7, newIncrement: 0 }, NOW);
    expect(r.state).toBe('active');
    expect(r.passes).toBe(2);
    expect(r.intervalDays).toBe(SPACING_LADDER[4]); // 60
  });
});
