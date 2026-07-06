import { describe, it, expect } from 'vitest';
import { countCallouts, nextMaturity, proseGrowthIncrement, SPACING_LADDER, PROSE_CHARS_PER_CALLOUT } from '../maintenance-policy';

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

describe('proseGrowthIncrement', () => {
  it('正文净增 = floor(增量 / PROSE_CHARS_PER_CALLOUT)', () => {
    const draft = 'a'.repeat(100);
    const final = 'a'.repeat(100 + PROSE_CHARS_PER_CALLOUT * 2 + 10);
    expect(proseGrowthIncrement(draft, final)).toBe(2);
  });
  it('无增长/缩水 → 0', () => {
    expect(proseGrowthIncrement('a'.repeat(500), 'a'.repeat(500))).toBe(0);
    expect(proseGrowthIncrement('a'.repeat(500), 'a'.repeat(100))).toBe(0);
  });
});

describe('nextMaturity 递减回报', () => {
  it('零增量 + 已多遍 → 毕业（间隔置 0、状态 graduated）', () => {
    const r = nextMaturity({ state: 'active', passes: 3, intervalDays: 7, newIncrement: 0, qualityDelta: 0 }, NOW);
    expect(r.state).toBe('graduated');
    expect(r.intervalDays).toBe(0);
    expect(new Date(r.nextDueAt).getTime()).toBeGreaterThan(NOW.getTime() + 365 * 86_400_000); // 远期
  });

  it('零增量 + 遍数少 → 间隔快涨（阶梯 +2）不毕业', () => {
    const r = nextMaturity({ state: 'active', passes: 0, intervalDays: 1, newIncrement: 0, qualityDelta: 0 }, NOW);
    expect(r.state).toBe('active');
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 1 → +2 档 → 7
  });

  it('大量新增量 + 质量改善 → 间隔慢涨（停在当前档，页还在长身体）', () => {
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 3, newIncrement: 5, qualityDelta: 1 }, NOW);
    expect(r.intervalDays).toBe(3); // 不前进
    expect(r.passes).toBe(2);
  });

  it('少量新增量 + 质量改善 → 阶梯 +1', () => {
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 3, newIncrement: 1, qualityDelta: 1 }, NOW);
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 3 → 7
  });

  it('阶梯顶端（60d）+1 不超出最大档，间隔钳制在 60', () => {
    // ladderIndex(60)=4，step=1（少量新增），ni=Math.min(4,5)=4 → SPACING_LADDER[4]=60
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 60, newIncrement: 1, qualityDelta: 1 }, NOW);
    expect(r.intervalDays).toBe(60);
    expect(r.state).toBe('active');
  });

  it('零增量 + passes 将变为 2（<3）→ 仍 active，间隔 +2 档', () => {
    // passes=1+1=2 < GRADUATE_AFTER_PASSES(3) → 不毕业
    // ladderIndex(7)=2，ni=Math.min(4,2+2)=4 → SPACING_LADDER[4]=60
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 7, newIncrement: 0, qualityDelta: 0 }, NOW);
    expect(r.state).toBe('active');
    expect(r.passes).toBe(2);
    expect(r.intervalDays).toBe(SPACING_LADDER[4]); // 60
  });
});

describe('T1.8 质量优先：体量信号降权', () => {
  it('质量无改善（qualityDelta=0）+ 正文大幅增长 → 进入 saturation 轨道（不因体量续命）', () => {
    // newIncrement 很大（大量体量增长），但 qualityDelta<=0 → effectiveIncrement 清零 → 走零增量分支
    const r = nextMaturity({ state: 'active', passes: 0, intervalDays: 1, newIncrement: 20, qualityDelta: 0 }, NOW);
    expect(r.state).toBe('active');
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 与「零增量 + 遍数少」同一条 saturation 路径（1 → +2 档 → 7）
  });

  it('质量无改善 + 已跑够遍数 + 正文仍大幅增长 → 照常毕业（体量不能阻止毕业）', () => {
    const r = nextMaturity({ state: 'active', passes: 3, intervalDays: 7, newIncrement: 20, qualityDelta: -1 }, NOW);
    expect(r.state).toBe('graduated');
  });

  it('qualityDelta>0 → 正常推进（体量信号照常计入，不被降权）', () => {
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 3, newIncrement: 1, qualityDelta: 2 }, NOW);
    expect(r.state).toBe('active');
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 3 → 7（少量新增 +1 档，等价旧行为）
  });

  it('stale 源页满足其他毕业条件也不毕业：留在当前档，不 +2、不毕业', () => {
    const r = nextMaturity(
      { state: 'active', passes: 3, intervalDays: 7, newIncrement: 0, qualityDelta: 0, staleSource: true },
      NOW,
    );
    expect(r.state).toBe('active');
    expect(r.intervalDays).toBe(7); // 留在当前档，既不 +2 也不毕业
    expect(r.passes).toBe(4);
  });

  it('stale 源页即便体量+质量都很好，只要落进零有效增量分支仍不因 stale 被误判', () => {
    // qualityDelta>0 时 stale 不生效（走正常推进分支，非零增量分支）——stale 只在"零有效增量"时才是前置阻断
    const r = nextMaturity(
      { state: 'active', passes: 1, intervalDays: 3, newIncrement: 1, qualityDelta: 1, staleSource: true },
      NOW,
    );
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 3 → 7，与非 stale 情形一致
  });
});
