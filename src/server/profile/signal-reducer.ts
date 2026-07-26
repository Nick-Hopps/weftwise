import {
  StylePrefs, READING_LEVELS, VERBOSITY_LEVELS, EXAMPLE_DENSITIES, stepLevel,
} from './style';
import { STYLE_BEARING_EVIDENCE_KINDS, type EvidenceKind, type EvidenceRow } from '@/lib/contracts';

/**
 * 只有这两种证据说的是**讲法**，其余说的是**掌握度**。必须以**显式白名单**表达，
 * 不能用 polarity 之类的属性顺带筛。
 *
 * 若 `quiz-wrong`（这道题答错了）/ `selection-ask`（这段没看懂）混进来，读者每答错
 * 一道题就把全库 `readingLevel` 往下推一格——这恰恰是本设计要修的「领域无关的
 * 全局降档」，会以更隐蔽的形式复发。
 */
export const STYLE_BEARING_KINDS: ReadonlySet<EvidenceKind> = new Set(
  STYLE_BEARING_EVIDENCE_KINDS,
);

/** 证据的风格有效期（天）。超窗完全不参与——三个月前的点击不该与今天等权。 */
export const STYLE_WINDOW_DAYS = 30;

/**
 * 衰减前的等权期（天）。近两周内的反馈同等有效，再往前才逐步淡出。
 *
 * 不用「从第一天就线性衰减」：那样连续两次点击的合计权重恒 < 2，`readingLevel`
 * 这一档实际上永远够不到，衰减就把整个学习闭环一起关掉了。
 */
export const STYLE_FULL_WEIGHT_DAYS = 14;

/**
 * 三个维度**各自独立**的阈值，不再一次信号同时推动三个。
 *
 * 阈值递增是刻意的：「太难」最直接的含义就是档次太高，先动 `readingLevel`；
 * 反复说了还嫌难，才值得加长解释；再往上才加例子。一次点击同时推三个维度，
 * 等于把一个低分辨率信号放大成三处改动。
 */
export const DIMENSION_THRESHOLDS = {
  readingLevel: 2,
  verbosity: 3,
  exampleDensity: 4,
} as const;

export interface ReduceOptions {
  now: Date;
  /**
   * 消费边界：只统计**上次旋钮调整之后**的证据（`user_profiles.style_prefs_updated_at`）。
   * `null` 表示从未调过，消费全部历史。
   *
   * 这是消除棘轮的关键——原实现按 id 裸取最近 N 条、从不标记消费，于是第 3 次同向
   * 点击时窗口净值仍达阈值，会再降一档。
   */
  since: string | null;
}

const DAY_MS = 86_400_000;

/** 等权期内为 1，之后线性淡出到窗口边缘的 0，超窗为 0。 */
function decayWeight(createdAt: string, now: Date): number {
  const ageDays = (now.getTime() - new Date(createdAt).getTime()) / DAY_MS;
  if (ageDays >= STYLE_WINDOW_DAYS) return 0;
  // 未来时间戳（时钟回拨）按全新处理，与 deriveMastery 的取向一致。
  if (ageDays <= STYLE_FULL_WEIGHT_DAYS) return 1;
  return 1 - (ageDays - STYLE_FULL_WEIGHT_DAYS) / (STYLE_WINDOW_DAYS - STYLE_FULL_WEIGHT_DAYS);
}

/**
 * 把窗口内的 style-bearing 证据聚合成对 `StylePrefs` 的一次有界微调。
 *
 * **`formality` 永远不动**——语气是读者的口味，不是难度信号能推断的东西，只手动可调。
 */
export function applyEvidenceToStyle(
  prefs: StylePrefs,
  evidence: readonly EvidenceRow[],
  { now, since }: ReduceOptions,
): { prefs: StylePrefs; changed: boolean } {
  let simpler = 0;
  let deeper = 0;

  for (const row of evidence) {
    if (!STYLE_BEARING_KINDS.has(row.kind)) continue;
    if (since !== null && row.createdAt <= since) continue;
    const weight = decayWeight(row.createdAt, now);
    if (weight <= 0) continue;
    if (row.kind === 'self-report-hard') simpler += weight;
    else deeper += weight;
  }

  const net = simpler - deeper;
  const magnitude = Math.abs(net);
  if (magnitude < DIMENSION_THRESHOLDS.readingLevel) return { prefs, changed: false };

  const wantsSimpler = net > 0;
  const next: StylePrefs = { ...prefs };

  next.readingLevel = stepLevel(READING_LEVELS, prefs.readingLevel, wantsSimpler ? -1 : +1);
  if (magnitude >= DIMENSION_THRESHOLDS.verbosity) {
    next.verbosity = stepLevel(VERBOSITY_LEVELS, prefs.verbosity, wantsSimpler ? +1 : -1);
  }
  if (magnitude >= DIMENSION_THRESHOLDS.exampleDensity) {
    next.exampleDensity = stepLevel(EXAMPLE_DENSITIES, prefs.exampleDensity, wantsSimpler ? +1 : -1);
  }

  const changed = JSON.stringify(next) !== JSON.stringify(prefs);
  return { prefs: changed ? next : prefs, changed };
}
