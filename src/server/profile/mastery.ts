/**
 * 四态掌握度派生 —— 本模块是纯函数、零 IO，是 `page_evidence` 唯一的解释器。
 *
 * 设计要点见 `docs/specs/2026-07-26-mastery-evidence-model.md`：
 * - 决策 2：四态 + 三档置信度，不落标量分数（从稀疏证据派生的估计，印一个「72」是假精度）
 * - 决策 3：显式优先级先命中先返回，不用加权求和（权重拍脑袋且结果不可解释）
 * - 决策 4：`mastered` 有效期 = 复习到期**再逾期一档**才降级
 *
 * 贯穿全篇的约束：**默认保守**。无证据即「不懂」；误判「已掌握」会让重塑版跳过解释、
 * 页面直接读不懂——这是本功能唯一真正危险的失败模式。
 */

import type {
  EvidenceRow,
  MasteryConfidence,
  MasteryState,
  MasteryVerdict,
  MasteryVerdictLite,
} from '@/lib/contracts';

export type { EvidenceRow, MasteryConfidence, MasteryState, MasteryVerdict, MasteryVerdictLite };

const DAY_MS = 86_400_000;

/**
 * 间隔重复节律。与 `maintenance-policy.ts` 共用同一组常量但**不共用函数**——
 * 那边给「内容」排增益计划，这边给 `(user, page)` 排记忆有效期，语义已经分化，
 * 耦合会让任一侧的调整误伤另一侧。
 */
export const SPACING_LADDER = [1, 3, 7, 21, 60] as const;

/**
 * 强负证据的有效窗口（天）。超窗即认为「那次卡住已经过去了」。
 *
 * 取 14 天的理由：它必须短于连击 3 的失效期（28 天），否则一次答错会把这一页
 * 长期钉死在 `struggling`，`mastered` 在有 quiz 的页面上几乎不可达；又要长到
 * 足以覆盖「这周没空回来看」。接入真实数据后按 `struggling` 的实际分布再调。
 */
export const NEGATIVE_WINDOW_DAYS = 14;

/** `recent` 的截断上限：审计面一次展开不会看更多，响应体也不该无界增长。 */
export const MAX_RECENT_EVIDENCE = 20;

/**
 * 连击的最小间隔（小时）。两条正证据相隔不足这个数就只算一次复习。
 *
 * **刻意不用「日历日」**：日历日需要一个时区，而服务端不知道读者在哪个时区、证据行里
 * 也没存。按 UTC 日折叠时，UTC+8 的早 7:30 与 8:30 分属两个 UTC 日——同一坐被算成
 * 两次复习，有效期从 +4 天虚涨到 +10 天。任何选定的时区都会在某种作息下出错。
 *
 * 取 16 小时：落在「同一天内的两次」（≤12h）与「每日节律」（≥24h）之间，
 * 并给每日复习留 8 小时的作息浮动余量。接入真实数据后按连击分布再调。
 */
export const STREAK_MIN_GAP_HOURS = 16;

/**
 * 决策 4 的两级语义。
 *
 * 阶梯本身**不是**有效期——它说的是「什么时候该复习」，不是「知识什么时候失效」。
 * 到期该复习 ≠ 到期就当作不会了。直接拿间隔当有效期的话，答对一次只维持 1 天，
 * 而系统里没有任何机制提示用户回去重答。
 */
export function masteryWindowDays(consecutivePositives: number): {
  dueDays: number;
  expiryDays: number;
} {
  const last = SPACING_LADDER.length - 1;
  const i = Math.min(Math.max(consecutivePositives - 1, 0), last);
  const dueDays = SPACING_LADDER[i];
  return { dueDays, expiryDays: dueDays + SPACING_LADDER[Math.min(i + 1, last)] };
}

function isStrongNegative(row: EvidenceRow): boolean {
  return row.polarity === 'negative' && row.strength === 'strong';
}

interface Streak {
  /** 按 `STREAK_MIN_GAP_HOURS` 折叠后的连续正证据次数。 */
  count: number;
  /** 参与本轮连击的正证据（未折叠，供 strength 门槛计数）。 */
  positives: EvidenceRow[];
  lastPositiveAt: string | null;
}

/**
 * `consecutivePositives` 的三条精确定义，每条都对应一个会让公式失真的具体失败：
 *
 * 1. **页级，不是题级**——同一页上任意正证据都累加。题级连击要求用户回去重答同一道题，
 *    没有任何机制促成，实际不可达。
 * 2. **按最小间隔去重，不按行计数**——否则反复点判分按钮就能把连击刷到 5，换来 120 天。
 *    证据表仍 append-only 全量保留（审计需要），只是派生时折叠。
 *    折叠单位是 `STREAK_MIN_GAP_HOURS` 而非日历日，理由见该常量的注释（时区）。
 * 3. **只有 strong 负证据清零**——`citation-hit`（问了个问题、回答引用了这一页，完全
 *    正常的事）不得把攒了几周的连击打回零。
 */
function computeStreak(sorted: EvidenceRow[]): Streak {
  let resetAt: string | null = null;
  for (const row of sorted) {
    if (isStrongNegative(row)) resetAt = row.createdAt;
  }

  const positives = sorted.filter(
    (r) => r.polarity === 'positive' && (resetAt === null || r.createdAt > resetAt),
  );

  // 线性扫描（`sorted` 已按时间正序）：第一条计数，其后只有距上一条**被计数**的
  // 正证据满一个最小间隔才计数。用「距上一条被计数的」而非「距上一条正证据」，
  // 否则每隔 15 小时点一下就能一路推进游标，把连击刷满。
  const gapMs = STREAK_MIN_GAP_HOURS * 3_600_000;
  let count = 0;
  let lastCountedMs = -Infinity;
  for (const row of positives) {
    const at = new Date(row.createdAt).getTime();
    if (at - lastCountedMs < gapMs) continue;
    count += 1;
    lastCountedMs = at;
  }

  return {
    count,
    positives,
    // 取最后一条正证据、**不是**最后一条被计数的：它的语义是「最近一次表现出掌握」，
    // 用于起算有效期。挪到被计数那条上，同一坐的第二次答对反而会缩短有效期。
    lastPositiveAt: positives.length ? positives[positives.length - 1].createdAt : null,
  };
}

/** 决策 3 的优先级表序号。报告按它归因，不必二次猜测判定是怎么来的。 */
export type MasteryRule = 1 | 2 | 3 | 4 | 5;

export interface MasteryExplanation {
  verdict: MasteryVerdict;
  /** 命中的优先级规则序号（决策 3 的表）。 */
  rule: MasteryRule;
  /** 折叠后的连击次数（见 `computeStreak`）。 */
  consecutivePositives: number;
  strongPositives: number;
  weakPositives: number;
  /** 衰减窗口内的强负证据条数（规则 2 的置信度依据）。 */
  recentStrongNegatives: number;
  /** 有正证据、却被规则 3 的 strength 门槛挡下而落 `exposed`。 */
  blockedByStrengthGate: boolean;
  /** 有足量正证据、但已过 `expiresAt` 而落 `exposed`。 */
  expiredPositives: boolean;
}

function verdict(
  state: MasteryState,
  confidence: MasteryConfidence,
  base: Pick<MasteryVerdict, 'evidenceCount' | 'lastEvidenceAt' | 'recent'>,
  windows: { dueAt: string | null; expiresAt: string | null } = { dueAt: null, expiresAt: null },
): MasteryVerdict {
  return { state, confidence, ...windows, ...base };
}

/**
 * 按决策 3 的优先级表自上而下先命中先返回，并**一并给出判定归因**。
 *
 * 任何结论都可以回溯到 `recent` 里的具体证据条目与时间——这是「掌握度必须可解释」
 * 那条约束的落点；`rule` 与几个计数字段则让离线报告能回答「为什么是这个状态」，
 * 而不必自己再判一遍。
 *
 * `deriveMastery` 是本函数丢掉解释字段的薄封装，**方向不能反**：
 * 两份判定分头演化必然漂移，报告就会开始撒谎。
 */
export function explainMastery(evidence: EvidenceRow[], now: Date): MasteryExplanation {
  const sorted = [...evidence].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const recent = [...evidence]
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
    .slice(0, MAX_RECENT_EVIDENCE);

  const base = {
    evidenceCount: evidence.length,
    lastEvidenceAt: sorted.length ? sorted[sorted.length - 1].createdAt : null,
    recent,
  };
  const explain = (
    rule: MasteryRule,
    v: MasteryVerdict,
    counts: Partial<Omit<MasteryExplanation, 'verdict' | 'rule'>> = {},
  ): MasteryExplanation => ({
    verdict: v,
    rule,
    consecutivePositives: 0,
    strongPositives: 0,
    weakPositives: 0,
    recentStrongNegatives: 0,
    blockedByStrengthGate: false,
    expiredPositives: false,
    ...counts,
  });

  // 规则 1：无任何证据。长期看这会是绝大多数页面的状态。
  if (sorted.length === 0) return explain(1, verdict('unknown', 'none', base));

  // 规则 2：衰减窗口内存在强负证据 → struggling。
  // 「负证据压过正证据」——哪怕 quiz 答对过；保守方向永远是「多讲一点」。
  const negativeCutoff = new Date(now.getTime() - NEGATIVE_WINDOW_DAYS * DAY_MS).toISOString();
  const recentStrongNegatives = sorted.filter(
    (r) => isStrongNegative(r) && r.createdAt >= negativeCutoff,
  ).length;
  if (recentStrongNegatives > 0) {
    return explain(
      2,
      verdict('struggling', recentStrongNegatives >= 2 ? 'high' : 'low', base),
      { recentStrongNegatives },
    );
  }

  // 规则 3：存在未过期的正证据，且（含 ≥1 条 strong 或 ≥2 条 weak）。
  const streak = computeStreak(sorted);
  const strongPositives = streak.positives.filter((r) => r.strength === 'strong').length;
  const weakPositives = streak.positives.length - strongPositives;
  const counts = { consecutivePositives: streak.count, strongPositives, weakPositives };

  if (streak.lastPositiveAt) {
    const { dueDays, expiryDays } = masteryWindowDays(streak.count);
    const lastMs = new Date(streak.lastPositiveAt).getTime();
    const dueAt = new Date(lastMs + dueDays * DAY_MS).toISOString();
    const expiresAt = new Date(lastMs + expiryDays * DAY_MS).toISOString();

    // strength 门槛是必须的：否则一条 `self-report-easy`（读者点一下「太浅」）就能把
    // 整页判成 mastered，重塑从此跳过解释它。自评答对同理——自我拔高偏差下的单条自陈
    // 不足以支撑「不必再讲」。
    const sufficient = strongPositives >= 1 || weakPositives >= 2;
    const live = now.toISOString() < expiresAt;

    if (sufficient && live) {
      // 四态判定只看 `expiresAt`；`dueAt`（该复习了）不参与判定，只供复习面消费。
      return explain(
        3,
        verdict('mastered', strongPositives >= 1 ? 'high' : 'low', base, { dueAt, expiresAt }),
        counts,
      );
    }
    // 落 exposed 的两种不同原因要分开报告：门槛太严与自然过期，
    // 对应的调整动作完全不同（改门槛 vs 加复习提醒）。
    return explain(4, verdict('exposed', 'low', base), {
      ...counts,
      blockedByStrengthGate: !sufficient,
      expiredPositives: sufficient && !live,
    });
  }

  // 规则 4/5：只有 exposure 证据，或只有弱负证据。都落 exposed——弱负证据信噪比不足以
  // 判 struggling，但足以证明「他接触过这一页」。
  const hasExposure = sorted.some((r) => r.polarity === 'exposure');
  return explain(hasExposure ? 4 : 5, verdict('exposed', 'low', base), counts);
}

/**
 * 四态派生的对外契约。spec ② 的 prompt 注入与 Graph 图层都只消费它。
 *
 * 它是 `explainMastery` 丢掉解释字段的薄封装——两者共用同一段判定逻辑。
 */
export function deriveMastery(evidence: EvidenceRow[], now: Date): MasteryVerdict {
  return explainMastery(evidence, now).verdict;
}

/**
 * 复习清单的判据（决策 4）。
 *
 * `mastered` 本身已排除过期项（过期即回落 `exposed`），所以这等价于
 * `dueAt <= now < expiresAt`——语义正是「该复习、但还没失效」。
 *
 * **刻意不含已过期回落 `exposed` 的页**：清单的语义是「维持你已有的掌握」。
 * 把失效的混进来会让它随时间单调膨胀成一个永远清不完的待办，那会让人直接忽略它，
 * 连带毁掉这个面的可信度。想找回失效的概念，走 Graph 审计面。
 */
export function isDueForReview(v: MasteryVerdictLite, now: Date): boolean {
  return v.state === 'mastered' && v.dueAt !== null && v.dueAt <= now.toISOString();
}
