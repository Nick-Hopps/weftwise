import { describe, it, expect } from 'vitest';
import {
  applyEvidenceToStyle,
  DIMENSION_THRESHOLDS,
  STYLE_WINDOW_DAYS,
  STYLE_FULL_WEIGHT_DAYS,
  STYLE_BEARING_KINDS,
} from '../signal-reducer';
import { DEFAULT_STYLE_PREFS, type StylePrefs } from '../style';
import { EVIDENCE_KIND_META, type EvidenceKind, type EvidenceRow } from '@/lib/contracts';

const NOW = new Date('2026-07-26T12:00:00.000Z');
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

function ev(kind: EvidenceKind, daysBefore = 0): EvidenceRow {
  const meta = EVIDENCE_KIND_META[kind];
  return {
    kind,
    polarity: meta.polarity,
    strength: meta.strength,
    anchor: null,
    createdAt: daysAgo(daysBefore),
  };
}

const hard = (d = 0) => ev('self-report-hard', d);
const easy = (d = 0) => ev('self-report-easy', d);

function reduce(
  rows: EvidenceRow[],
  prefs: StylePrefs = DEFAULT_STYLE_PREFS,
  since: string | null = null,
) {
  return applyEvidenceToStyle(prefs, rows, { now: NOW, since });
}

describe('style-bearing 白名单', () => {
  it('只有 self-report-hard / self-report-easy 两种', () => {
    // 这条断言锁死缺口 1 的隐蔽复发：`quiz-wrong` / `selection-ask` 说的是**掌握度**，
    // 不是**讲法**。混进来就等于「答错一道题，全库讲解深度降一格」。
    expect([...STYLE_BEARING_KINDS].sort()).toEqual(['self-report-easy', 'self-report-hard']);
  });

  it.each<EvidenceKind>([
    'quiz-wrong', 'quiz-correct', 'selection-ask', 'citation-hit',
    'reshape-request', 'page-read', 'concept-unknown',
  ])('%s 不参与风格调整', (kind) => {
    const rows = Array.from({ length: 10 }, () => ev(kind));
    expect(reduce(rows).changed).toBe(false);
  });

  it('concept-unknown 尤其不能推动 readingLevel', () => {
    // 它说的是「**别的那一页**讲的那个概念我不懂」，跟当前页讲法难度毫无关系。
    // 复用 self-report-hard 会让每一次纠错都顺手把全库讲解深度往下推一格。
    expect(reduce(Array.from({ length: 5 }, () => ev('concept-unknown'))).changed).toBe(false);
  });
});

describe('三个维度各自独立阈值（A5：不再一次信号同时推动三个）', () => {
  it('阈值递增：readingLevel < verbosity < exampleDensity', () => {
    expect(DIMENSION_THRESHOLDS.readingLevel).toBeLessThan(DIMENSION_THRESHOLDS.verbosity);
    expect(DIMENSION_THRESHOLDS.verbosity).toBeLessThan(DIMENSION_THRESHOLDS.exampleDensity);
  });

  it('刚到 readingLevel 阈值时只动 readingLevel', () => {
    const rows = Array.from({ length: DIMENSION_THRESHOLDS.readingLevel }, () => hard());
    const { prefs, changed } = reduce(rows);
    expect(changed).toBe(true);
    expect(prefs.readingLevel).toBe('beginner');
    expect(prefs.verbosity).toBe(DEFAULT_STYLE_PREFS.verbosity);
    expect(prefs.exampleDensity).toBe(DEFAULT_STYLE_PREFS.exampleDensity);
  });

  it('到 verbosity 阈值才连带加长解释', () => {
    const rows = Array.from({ length: DIMENSION_THRESHOLDS.verbosity }, () => hard());
    const { prefs } = reduce(rows);
    expect(prefs.readingLevel).toBe('beginner');
    expect(prefs.verbosity).toBe('thorough');
    expect(prefs.exampleDensity).toBe(DEFAULT_STYLE_PREFS.exampleDensity);
  });

  it('到 exampleDensity 阈值才连带加例子', () => {
    const rows = Array.from({ length: DIMENSION_THRESHOLDS.exampleDensity }, () => hard());
    expect(reduce(rows).prefs.exampleDensity).toBe('many');
  });

  it('反向（太浅）同样按阈值逐级推进', () => {
    const rows = Array.from({ length: DIMENSION_THRESHOLDS.verbosity }, () => easy());
    const { prefs } = reduce(rows);
    expect(prefs.readingLevel).toBe('advanced');
    expect(prefs.verbosity).toBe('terse');
  });

  it('正负相抵后不足阈值则不动', () => {
    expect(reduce([hard(), hard(), easy(), easy()]).changed).toBe(false);
  });
});

describe('A8：formality 只手动可调', () => {
  it('任何数量、任何方向的信号都不改动 formality', () => {
    for (const rows of [
      Array.from({ length: 20 }, () => hard()),
      Array.from({ length: 20 }, () => easy()),
    ]) {
      expect(reduce(rows).prefs.formality).toBe(DEFAULT_STYLE_PREFS.formality);
    }
  });
});

describe('A4：时间窗与衰减', () => {
  it('超窗证据完全不参与', () => {
    const rows = Array.from({ length: 10 }, () => hard(STYLE_WINDOW_DAYS + 1));
    expect(reduce(rows).changed).toBe(false);
  });

  it('旧点击不再与今天等权', () => {
    const fresh = Array.from({ length: 2 }, () => hard(0));
    const stale = Array.from({ length: 2 }, () => hard(STYLE_WINDOW_DAYS * 0.9));
    expect(reduce(fresh).changed).toBe(true);
    expect(reduce(stale).changed).toBe(false);
  });

  it('等权期内不打折：两周内的两条即可达 readingLevel 阈值', () => {
    // 从第一天就线性衰减的话，连续两次点击的合计权重恒 < 2，这一档永远够不到，
    // 衰减就把整个学习闭环一起关掉了。
    expect(reduce([hard(STYLE_FULL_WEIGHT_DAYS), hard(STYLE_FULL_WEIGHT_DAYS - 1)]).changed).toBe(true);
  });

  it('等权期之后逐步淡出：衰减区的两条不够，需要更多条数', () => {
    const aged = STYLE_WINDOW_DAYS - 4; // 权重 0.25
    expect(reduce(Array.from({ length: 2 }, () => hard(aged))).changed).toBe(false);
    expect(reduce(Array.from({ length: 8 }, () => hard(aged))).changed).toBe(true);
  });
});

describe('A3：消费边界消除棘轮', () => {
  it('上次调整之前的证据不再参与', () => {
    // 原实现按 id 裸取最近 8 条、从不标记消费，于是第 3 次同向点击时窗口净值仍 ≥2，
    // 会再降一档——单向棘轮。
    const rows = [hard(5), hard(4), hard(1)];
    expect(reduce(rows, DEFAULT_STYLE_PREFS, daysAgo(3)).changed).toBe(false);
  });

  it('同向连点不再每次降档', () => {
    // 第 1、2 次 → 降一档，边界推进到「此刻」；第 3 次只剩 1 条新证据，不足阈值。
    const first = reduce([hard(2), hard(1)]);
    expect(first.changed).toBe(true);

    const third = applyEvidenceToStyle(first.prefs, [hard(2), hard(1), hard(0)], {
      now: NOW,
      since: daysAgo(0.5),
    });
    expect(third.changed).toBe(false);
  });

  it('since 为 null 时消费全部历史（从未调过旋钮）', () => {
    expect(reduce([hard(10), hard(9)], DEFAULT_STYLE_PREFS, null).changed).toBe(true);
  });
});

describe('边界', () => {
  it('空输入不改变', () => {
    expect(reduce([])).toEqual({ prefs: DEFAULT_STYLE_PREFS, changed: false });
  });

  it('已到档位尽头时不再报 changed', () => {
    const floor: StylePrefs = {
      readingLevel: 'beginner', verbosity: 'thorough', exampleDensity: 'many', formality: 'neutral',
    };
    const rows = Array.from({ length: DIMENSION_THRESHOLDS.exampleDensity }, () => hard());
    expect(applyEvidenceToStyle(floor, rows, { now: NOW, since: null }).changed).toBe(false);
  });

  it('不修改传入的 prefs 对象', () => {
    const prefs = { ...DEFAULT_STYLE_PREFS };
    reduce(Array.from({ length: 10 }, () => hard()), prefs);
    expect(prefs).toEqual(DEFAULT_STYLE_PREFS);
  });
});
