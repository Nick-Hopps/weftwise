import { describe, expect, it } from 'vitest';
import { recallAtK, reciprocalRank, summarizeEval } from '../eval-metrics';

describe('recallAtK', () => {
  it('全部期望页都在 top-k 内 → 1', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a', 'b'], 5)) .toBe(1);
  });

  it('部分命中 → 命中比例', () => {
    expect(recallAtK(['a', 'x', 'y'], ['a', 'b'], 5)).toBe(0.5);
  });

  it('完全未命中 → 0', () => {
    expect(recallAtK(['x', 'y'], ['a', 'b'], 5)).toBe(0);
  });

  it('只看 top-k 之内，超出 k 的命中不计', () => {
    expect(recallAtK(['x', 'y', 'a'], ['a'], 2)).toBe(0);
    expect(recallAtK(['x', 'y', 'a'], ['a'], 3)).toBe(1);
  });

  it('expected 为空 → 定义为 1', () => {
    expect(recallAtK([], [], 5)).toBe(1);
  });

  it('ranked 为空、expected 非空 → 0', () => {
    expect(recallAtK([], ['a'], 5)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('首个期望页排第一 → 1', () => {
    expect(reciprocalRank(['a', 'b'], ['a'])).toBe(1);
  });

  it('首个命中排第三 → 1/3', () => {
    expect(reciprocalRank(['x', 'y', 'a'], ['a', 'b'])).toBeCloseTo(1 / 3);
  });

  it('多个期望页，取排名最靠前的那个', () => {
    expect(reciprocalRank(['x', 'b', 'a'], ['a', 'b'])).toBeCloseTo(1 / 2);
  });

  it('未命中 → 0', () => {
    expect(reciprocalRank(['x', 'y'], ['a'])).toBe(0);
  });

  it('expected 为空 → 0', () => {
    expect(reciprocalRank(['a'], [])).toBe(0);
  });

  it('ranked 为空 → 0', () => {
    expect(reciprocalRank([], ['a'])).toBe(0);
  });
});

describe('summarizeEval', () => {
  it('对多条查询结果求平均', () => {
    const summary = summarizeEval([
      { ranked: ['a', 'b'], expected: ['a'] }, // recall5=1 recall10=1 mrr=1
      { ranked: ['x', 'y'], expected: ['a'] }, // recall5=0 recall10=0 mrr=0
    ]);
    expect(summary.recallAt5).toBeCloseTo(0.5);
    expect(summary.recallAt10).toBeCloseTo(0.5);
    expect(summary.mrr).toBeCloseTo(0.5);
    expect(summary.queryCount).toBe(2);
  });

  it('空结果集 → 全 0', () => {
    const summary = summarizeEval([]);
    expect(summary).toEqual({ recallAt5: 0, recallAt10: 0, mrr: 0, queryCount: 0 });
  });
});
