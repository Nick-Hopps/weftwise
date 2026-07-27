/**
 * 掌握度观测报告的聚合层（纯函数，零 IO）。
 *
 * spec ① 留下三个明说「接入真实数据后再调」的常量（`READ_DWELL_MS` / `NEGATIVE_WINDOW_DAYS`
 * / 规则 3 的 strength 门槛）以及一条遗留观察（「若 `struggling` 恒 0，改为累计 ≥3 条
 * 弱负证据判 `struggling`」）。没有观测面，这些常量的调整只能凭感觉。
 *
 * 只报四态计数回答不了这些问题——真正需要知道的是**每个判定是怎么来的**，
 * 所以这里消费 `explainMastery` 的归因字段，而不是自己再判一遍。
 */

import { explainMastery, isDueForReview, type MasteryExplanation } from './mastery';
import type { EvidenceKind, EvidenceRow, MasteryState } from '@/lib/contracts';

export interface MasteryReportInput {
  slug: string;
  evidence: EvidenceRow[];
}

export interface MasteryReportPage {
  slug: string;
  state: MasteryState;
  explanation: MasteryExplanation;
}

export interface MasteryReport {
  /** 有证据的页数。没有证据的页不在输入里——它们恒为 `unknown`。 */
  pagesWithEvidence: number;
  evidenceRows: number;
  states: Record<MasteryState, number>;
  /** `mastered` 的置信度构成：low 的会被 E2 降级进「一句话回顾」段。 */
  masteredConfidence: { low: number; high: number };
  /** 有正证据、却被规则 3 的 strength 门槛挡下——`mastered` 恒空的第一嫌疑。 */
  blockedByStrengthGate: number;
  /** 曾经 mastered、已过 `expiresAt` 回落 exposed——复习闭环没跟上的直接证据。 */
  expiredPositives: number;
  /** 当前该复习且尚未失效。 */
  dueForReview: number;
  /** 只有弱负证据的页数：遗留观察「弱负证据累计 ≥3 判 struggling」的依据。 */
  weakNegativeOnly: number;
  /** `struggling` 的成因分布：全被 `selection-ask` 主导说明缺客观参照。 */
  strugglingByKind: Partial<Record<EvidenceKind, number>>;
  /** 全部证据的 kind 分布：计数为 0 的采集点是死的（spec ① 缺口 2 的复发检测）。 */
  evidenceByKind: Partial<Record<EvidenceKind, number>>;
  /** 各态下证据最多的若干页，供人工复核判定是否对得上。 */
  topByState: Record<MasteryState, Array<{ slug: string; evidenceCount: number }>>;
}

const EMPTY_STATES = (): Record<MasteryState, number> => ({
  unknown: 0,
  exposed: 0,
  mastered: 0,
  struggling: 0,
});

function bump<K extends string>(counter: Partial<Record<K, number>>, key: K): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * @param pages   仅**有证据**的页（无证据的页恒 `unknown`，不必逐页跑纯函数）
 * @param totalPages 该 subject 的可读页总数，用于推出 `unknown` 计数
 */
export function summarizeMasteryReport(
  pages: readonly MasteryReportInput[],
  totalPages: number,
  now: Date,
  topN = 5,
): MasteryReport {
  const states = EMPTY_STATES();
  const perState: Record<MasteryState, MasteryReportPage[]> = {
    unknown: [], exposed: [], mastered: [], struggling: [],
  };
  const report: MasteryReport = {
    pagesWithEvidence: pages.length,
    evidenceRows: 0,
    states,
    masteredConfidence: { low: 0, high: 0 },
    blockedByStrengthGate: 0,
    expiredPositives: 0,
    dueForReview: 0,
    weakNegativeOnly: 0,
    strugglingByKind: {},
    evidenceByKind: {},
    topByState: { unknown: [], exposed: [], mastered: [], struggling: [] },
  };

  for (const { slug, evidence } of pages) {
    report.evidenceRows += evidence.length;
    for (const row of evidence) bump(report.evidenceByKind, row.kind);

    const explanation = explainMastery(evidence, now);
    const { verdict } = explanation;
    states[verdict.state] += 1;
    perState[verdict.state].push({ slug, state: verdict.state, explanation });

    if (verdict.state === 'mastered') {
      if (verdict.confidence === 'high') report.masteredConfidence.high += 1;
      else report.masteredConfidence.low += 1;
      if (isDueForReview(verdict, now)) report.dueForReview += 1;
    }
    if (explanation.blockedByStrengthGate) report.blockedByStrengthGate += 1;
    if (explanation.expiredPositives) report.expiredPositives += 1;
    // 规则 5 = 只有弱负证据（既无 exposure，也无正证据、无近期强负证据）。
    if (explanation.rule === 5) report.weakNegativeOnly += 1;

    if (verdict.state === 'struggling') {
      for (const row of evidence) {
        if (row.polarity === 'negative' && row.strength === 'strong') {
          bump(report.strugglingByKind, row.kind);
        }
      }
    }
  }

  // `unknown` 由页面总数减去有证据的页数推出——`page_evidence` 里根本没有它们的行，
  // 而那一大片恰恰是最有信息量的数字（同 Graph 图层 `summarizeMastery` 的思路）。
  states.unknown = Math.max(0, totalPages - pages.length);

  for (const state of ['exposed', 'mastered', 'struggling'] as const) {
    report.topByState[state] = perState[state]
      .slice()
      .sort((a, b) => b.explanation.verdict.evidenceCount - a.explanation.verdict.evidenceCount)
      .slice(0, topN)
      .map((p) => ({ slug: p.slug, evidenceCount: p.explanation.verdict.evidenceCount }));
  }

  return report;
}
