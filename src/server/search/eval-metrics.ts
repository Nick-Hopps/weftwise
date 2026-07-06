/** 检索评估纯函数：recall@k / MRR（T2.5 检索评估基线单一真实源）。 */

/**
 * recall@k：expected 中至少命中的比例（0~1）。
 * expected 为空 → 定义为 1（无期望即视为满足）；ranked 为空 → 0（除非 expected 也空）。
 */
export function recallAtK(ranked: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  const hits = expected.filter((slug) => top.has(slug)).length;
  return hits / expected.length;
}

/**
 * MRR：expected 中任意页首次出现在 ranked 的排名（1-based）的倒数；
 * 无命中或 expected 为空 → 0。
 */
export function reciprocalRank(ranked: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  const expectedSet = new Set(expected);
  for (let i = 0; i < ranked.length; i++) {
    if (expectedSet.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export interface EvalSummary {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  queryCount: number;
}

/** 对一批查询结果求各指标的平均值。 */
export function summarizeEval(
  results: { ranked: string[]; expected: string[] }[]
): EvalSummary {
  if (results.length === 0) {
    return { recallAt5: 0, recallAt10: 0, mrr: 0, queryCount: 0 };
  }
  const n = results.length;
  const recallAt5 = results.reduce((sum, r) => sum + recallAtK(r.ranked, r.expected, 5), 0) / n;
  const recallAt10 = results.reduce((sum, r) => sum + recallAtK(r.ranked, r.expected, 10), 0) / n;
  const mrr = results.reduce((sum, r) => sum + reciprocalRank(r.ranked, r.expected), 0) / n;
  return { recallAt5, recallAt10, mrr, queryCount: n };
}
