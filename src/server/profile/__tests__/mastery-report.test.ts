import { describe, it, expect } from 'vitest';
import { summarizeMasteryReport, type MasteryReportInput } from '../mastery-report';
import { EVIDENCE_KIND_META, type EvidenceKind, type EvidenceRow } from '@/lib/contracts';

const NOW = new Date('2026-07-27T12:00:00.000Z');
const DAY_MS = 86_400_000;

function ev(kind: EvidenceKind, daysBefore: number, over: Partial<EvidenceRow> = {}): EvidenceRow {
  const meta = EVIDENCE_KIND_META[kind];
  return {
    kind,
    polarity: meta.polarity,
    strength: meta.strength,
    anchor: null,
    createdAt: new Date(NOW.getTime() - daysBefore * DAY_MS).toISOString(),
    ...over,
  };
}

const gradedCorrect = (daysBefore: number, anchor = 'q1'): EvidenceRow =>
  ev('quiz-correct', daysBefore, { strength: 'strong', anchor });

function report(pages: MasteryReportInput[], totalPages = pages.length) {
  return summarizeMasteryReport(pages, totalPages, NOW);
}

describe('summarizeMasteryReport', () => {
  it('空库：全部为零，unknown 由页面总数推出', () => {
    const r = report([], 12);
    expect(r.pagesWithEvidence).toBe(0);
    expect(r.evidenceRows).toBe(0);
    expect(r.states).toEqual({ unknown: 12, exposed: 0, mastered: 0, struggling: 0 });
    expect(r.evidenceByKind).toEqual({});
  });

  it('unknown 由总数减去有证据的页数推出（证据表里根本没有它们的行）', () => {
    const r = report([{ slug: 'a', evidence: [gradedCorrect(0.5)] }], 10);
    expect(r.states.mastered).toBe(1);
    expect(r.states.unknown).toBe(9);
  });

  it('页数超过总数时 unknown 钳制为 0，不出现负数', () => {
    expect(report([{ slug: 'a', evidence: [ev('page-read', 1)] }], 0).states.unknown).toBe(0);
  });

  it('四态计数与置信度构成', () => {
    const r = report([
      { slug: 'm-high', evidence: [gradedCorrect(0.5)] },
      { slug: 'm-low', evidence: [ev('quiz-correct', 3, { anchor: 'a' }), ev('quiz-correct', 1, { anchor: 'b' })] },
      { slug: 's', evidence: [ev('quiz-wrong', 1)] },
      { slug: 'e', evidence: [ev('page-read', 1)] },
    ]);
    expect(r.states).toMatchObject({ mastered: 2, struggling: 1, exposed: 1 });
    expect(r.masteredConfidence).toEqual({ low: 1, high: 1 });
  });

  it('blockedByStrengthGate 计数：mastered 恒空的第一嫌疑', () => {
    const r = report([
      { slug: 'gated-a', evidence: [ev('self-report-easy', 1)] },
      { slug: 'gated-b', evidence: [ev('quiz-correct', 1)] },
      { slug: 'ok', evidence: [gradedCorrect(0.5)] },
      { slug: 'exposure-only', evidence: [ev('page-read', 1)] },
    ]);
    expect(r.blockedByStrengthGate).toBe(2);
  });

  it('expiredPositives 与 dueForReview 分别反映「没跟上」与「该跟进」', () => {
    const r = report([
      // 连击 1：+1 天该复习 / +4 天失效。3 天前答对 → 到期未失效。
      { slug: 'due', evidence: [gradedCorrect(3)] },
      // 5 天前答对 → 已失效回落 exposed。
      { slug: 'expired', evidence: [gradedCorrect(5)] },
      // 刚答对 → 还没到该复习的时候。
      { slug: 'fresh', evidence: [gradedCorrect(0.1)] },
    ]);
    expect(r.dueForReview).toBe(1);
    expect(r.expiredPositives).toBe(1);
    expect(r.states).toMatchObject({ mastered: 2, exposed: 1 });
  });

  it('weakNegativeOnly 统计只有弱负证据的页（放松 struggling 判据的依据）', () => {
    const r = report([
      { slug: 'weak-neg', evidence: [ev('citation-hit', 1), ev('reshape-request', 2)] },
      { slug: 'exposure', evidence: [ev('page-read', 1)] },
      { slug: 'strong-neg', evidence: [ev('quiz-wrong', 1)] },
    ]);
    expect(r.weakNegativeOnly).toBe(1);
  });

  it('strugglingByKind 只统计强负证据（弱负证据不参与该判定）', () => {
    const r = report([
      { slug: 'a', evidence: [ev('selection-ask', 1), ev('citation-hit', 1)] },
      { slug: 'b', evidence: [ev('quiz-wrong', 1), ev('selection-ask', 2)] },
    ]);
    expect(r.strugglingByKind).toEqual({ 'selection-ask': 2, 'quiz-wrong': 1 });
  });

  it('evidenceByKind 覆盖全部证据，用于发现死掉的采集点', () => {
    const r = report([
      { slug: 'a', evidence: [ev('page-read', 1), ev('page-read', 2), ev('citation-hit', 1)] },
    ]);
    expect(r.evidenceByKind).toEqual({ 'page-read': 2, 'citation-hit': 1 });
    expect(r.evidenceRows).toBe(3);
    // 从未产生过的 kind 不出现在分布里——这正是「采集点是死的」的信号
    expect(r.evidenceByKind['quiz-correct']).toBeUndefined();
  });

  it('topByState 按证据数降序有界截断，unknown 段恒空（无行可列）', () => {
    const pages = Array.from({ length: 8 }, (_, i) => ({
      slug: `p${i}`,
      evidence: Array.from({ length: i + 1 }, (_, j) => ev('page-read', j + 1)),
    }));
    const r = summarizeMasteryReport(pages, 8, NOW, 3);
    expect(r.topByState.exposed.map((p) => p.slug)).toEqual(['p7', 'p6', 'p5']);
    expect(r.topByState.exposed[0].evidenceCount).toBe(8);
    expect(r.topByState.unknown).toEqual([]);
  });
});
