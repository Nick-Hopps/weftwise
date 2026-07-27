import { describe, it, expect } from 'vitest';
import {
  deriveMastery,
  explainMastery,
  isDueForReview,
  masteryWindowDays,
  MAX_RECENT_EVIDENCE,
  NEGATIVE_WINDOW_DAYS,
  SPACING_LADDER,
  STREAK_MIN_GAP_HOURS,
} from '../mastery';
import { EVIDENCE_KIND_META, type EvidenceKind, type EvidenceRow } from '@/lib/contracts';

const NOW = new Date('2026-07-26T12:00:00.000Z');
const DAY_MS = 86_400_000;

/** 相对 NOW 往前 n 天（可带小数）。 */
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

/** 按 kind 的权重表造一条证据；strength 可覆盖（仅 quiz-correct 有此不对称）。 */
function ev(
  kind: EvidenceKind,
  daysBefore: number,
  overrides: Partial<EvidenceRow> = {},
): EvidenceRow {
  const meta = EVIDENCE_KIND_META[kind];
  return {
    kind,
    polarity: meta.polarity,
    strength: meta.strength,
    anchor: null,
    createdAt: daysAgo(daysBefore),
    ...overrides,
  };
}

/** 揭晓答案后判对：strong positive。 */
function gradedCorrect(daysBefore: number, anchor = 'q1'): EvidenceRow {
  return ev('quiz-correct', daysBefore, { strength: 'strong', anchor });
}

/** 揭晓答案后判对，按绝对时刻给定——连击的间隔语义要精确到小时，天为单位不够用。 */
function gradedCorrectAt(iso: string, anchor = 'q1'): EvidenceRow {
  return {
    kind: 'quiz-correct',
    polarity: 'positive',
    strength: 'strong',
    anchor,
    createdAt: new Date(iso).toISOString(),
  };
}

/** 由 `expiresAt` 反推派生出的连击档位，避免测试到处手算日期。 */
function streakFromExpiry(v: { expiresAt: string | null }, lastPositiveIso: string): number {
  if (v.expiresAt === null) return 0;
  const expiryDays = Math.round(
    (new Date(v.expiresAt).getTime() - new Date(lastPositiveIso).getTime()) / DAY_MS,
  );
  for (let n = 1; n <= SPACING_LADDER.length; n++) {
    if (masteryWindowDays(n).expiryDays === expiryDays) return n;
  }
  throw new Error(`expiryDays ${expiryDays} 不对应任何连击档位`);
}

describe('masteryWindowDays（决策 4 的两级语义）', () => {
  it('逐档断言：复习到期 与 失效 是两个不同的量', () => {
    expect(masteryWindowDays(1)).toEqual({ dueDays: 1, expiryDays: 4 });
    expect(masteryWindowDays(2)).toEqual({ dueDays: 3, expiryDays: 10 });
    expect(masteryWindowDays(3)).toEqual({ dueDays: 7, expiryDays: 28 });
    expect(masteryWindowDays(4)).toEqual({ dueDays: 21, expiryDays: 81 });
    expect(masteryWindowDays(5)).toEqual({ dueDays: 60, expiryDays: 120 });
  });

  it('超过阶梯长度后钳制在最后一档', () => {
    expect(masteryWindowDays(6)).toEqual({ dueDays: 60, expiryDays: 120 });
    expect(masteryWindowDays(50)).toEqual({ dueDays: 60, expiryDays: 120 });
  });

  it('expiryDays 恒 > dueDays', () => {
    // 这条锁死的是原设计的阻断级缺陷：把间隔重复的阶梯直接当有效期，
    // 答对一次只维持 1 天，而系统里没有任何机制提示用户回去重答——
    // mastered 会几乎恒为空，下游注入等于没做。
    for (let n = 1; n <= SPACING_LADDER.length + 3; n++) {
      const { dueDays, expiryDays } = masteryWindowDays(n);
      expect(expiryDays, `连击 ${n}`).toBeGreaterThan(dueDays);
    }
  });
});

describe('deriveMastery：优先级 1 —— 无证据', () => {
  it('空输入 → unknown / none，其余字段为空', () => {
    expect(deriveMastery([], NOW)).toEqual({
      state: 'unknown',
      confidence: 'none',
      evidenceCount: 0,
      lastEvidenceAt: null,
      dueAt: null,
      expiresAt: null,
      recent: [],
    });
  });
});

describe('deriveMastery：优先级 2 —— 强负证据', () => {
  it.each<EvidenceKind>(['quiz-wrong', 'selection-ask', 'self-report-hard', 'concept-unknown'])(
    '%s 单条即判 struggling / low',
    (kind) => {
      const v = deriveMastery([ev(kind, 1)], NOW);
      expect(v.state).toBe('struggling');
      expect(v.confidence).toBe('low');
      expect(v.expiresAt).toBeNull();
    },
  );

  it('两条强负证据 → high', () => {
    const v = deriveMastery([ev('quiz-wrong', 2), ev('selection-ask', 1)], NOW);
    expect(v).toMatchObject({ state: 'struggling', confidence: 'high' });
  });

  it('负证据压过正证据：答对过但近期卡住 → struggling', () => {
    const v = deriveMastery([gradedCorrect(3), ev('selection-ask', 1)], NOW);
    expect(v.state).toBe('struggling');
  });

  it('超出衰减窗口的强负证据不再判 struggling', () => {
    const v = deriveMastery([ev('quiz-wrong', NEGATIVE_WINDOW_DAYS + 1)], NOW);
    expect(v.state).toBe('exposed');
  });

  it('弱负证据单独出现 → exposed，不判 struggling（已定决策 4）', () => {
    // 信噪比不足：问到某页可能只是查资料，重塑可能只是想换讲法。
    const v = deriveMastery([ev('citation-hit', 1), ev('reshape-request', 1)], NOW);
    expect(v).toMatchObject({ state: 'exposed', confidence: 'low' });
  });
});

describe('deriveMastery：优先级 3 —— strength 门槛', () => {
  it('单条 self-report-easy 不足以判 mastered → exposed', () => {
    // 读者点一下「太浅」就把整页判成已掌握、重塑从此跳过解释它，
    // 正是决策 2 要防的那个最危险失败。
    const v = deriveMastery([ev('self-report-easy', 1)], NOW);
    expect(v).toMatchObject({ state: 'exposed', confidence: 'low' });
  });

  it('单条 weak quiz-correct（无答案自评）也不足以判 mastered', () => {
    const v = deriveMastery([ev('quiz-correct', 1)], NOW);
    expect(v.state).toBe('exposed');
  });

  it('两条 weak 正证据 → mastered / low', () => {
    const v = deriveMastery(
      [ev('quiz-correct', 1, { anchor: 'q1' }), ev('quiz-correct', 1, { anchor: 'q2' })],
      NOW,
    );
    expect(v).toMatchObject({ state: 'mastered', confidence: 'low' });
  });

  it('含 strong 正证据 → mastered / high', () => {
    const v = deriveMastery([gradedCorrect(1)], NOW);
    expect(v).toMatchObject({ state: 'mastered', confidence: 'high' });
    expect(v.expiresAt).not.toBeNull();
  });
});

describe('deriveMastery：优先级 4/5 —— exposed', () => {
  it('只有 exposure 证据 → exposed / low', () => {
    const v = deriveMastery([ev('page-read', 1)], NOW);
    expect(v).toMatchObject({ state: 'exposed', confidence: 'low' });
  });

  it('mastered 过期回落 exposed 而非 unknown（他确实接触过）', () => {
    // 连击 1 → 失效 +4 天
    const v = deriveMastery([gradedCorrect(5)], NOW);
    expect(v.state).toBe('exposed');
    expect(v.expiresAt).toBeNull();
  });

  it('恰好在失效边界内仍是 mastered', () => {
    const v = deriveMastery([gradedCorrect(3.9)], NOW);
    expect(v.state).toBe('mastered');
  });
});

describe('deriveMastery：连击的三条定义（决策 4）', () => {
  it('页级累加：同页不同 quiz 各答对一次即可延长，不要求重答同一道题', () => {
    const v = deriveMastery(
      [gradedCorrect(20, 'q1'), gradedCorrect(10, 'q2'), gradedCorrect(1, 'q3')],
      NOW,
    );
    // 连击 3 → 失效 +28 天，仍在有效期内
    expect(v.state).toBe('mastered');
    expect(v.expiresAt).toBe(new Date(NOW.getTime() + (28 - 1) * DAY_MS).toISOString());
  });

  it('同一天多条正证据只算 1（防反复点判分刷到 120 天）', () => {
    // 同一分钟点五下不构成五次复习——间隔重复的语义本来就是「隔一段时间再答对一次」。
    const sameDay = [
      gradedCorrect(1, 'a'), gradedCorrect(1, 'b'), gradedCorrect(1, 'c'),
      gradedCorrect(1, 'd'), gradedCorrect(1, 'e'),
    ];
    const v = deriveMastery(sameDay, NOW);
    // 连击算 1 → 失效 +4 天，而非连击 5 的 +120 天
    expect(v.expiresAt).toBe(new Date(NOW.getTime() + (4 - 1) * DAY_MS).toISOString());
  });

  it('只有 strong 负证据清零连击，citation-hit 不得打断', () => {
    // 问了个问题、回答引用了这一页，是完全正常的事，不该把攒了几周的连击打回零。
    const withWeakNegative = deriveMastery(
      [gradedCorrect(20, 'q1'), ev('citation-hit', 15), gradedCorrect(10, 'q2'), gradedCorrect(1, 'q3')],
      NOW,
    );
    expect(withWeakNegative.expiresAt).toBe(
      new Date(NOW.getTime() + (28 - 1) * DAY_MS).toISOString(),
    );

    // 对照：同样的正证据，中间换成 strong 负证据 → 连击从它之后重新起算
    const withStrongNegative = deriveMastery(
      [
        gradedCorrect(40, 'q1'),
        ev('quiz-wrong', 35),
        gradedCorrect(30, 'q2'),
        gradedCorrect(1, 'q3'),
      ],
      NOW,
    );
    // 强负证据已超窗（不判 struggling），其后只剩 2 条正证据 → 连击 2 → 失效 +10 天
    expect(withStrongNegative.state).toBe('mastered');
    expect(withStrongNegative.expiresAt).toBe(
      new Date(NOW.getTime() + (10 - 1) * DAY_MS).toISOString(),
    );
  });
});

describe('deriveMastery：连击按滚动间隔折叠（决策 1）', () => {
  /** 造两条相隔 `gapHours` 的 strong 正证据，返回派生出的连击档位。 */
  function streakForGap(gapHours: number): number {
    const second = new Date(NOW.getTime() - 2 * 3_600_000);
    const first = new Date(second.getTime() - gapHours * 3_600_000);
    const v = deriveMastery(
      [gradedCorrectAt(first.toISOString(), 'q1'), gradedCorrectAt(second.toISOString(), 'q2')],
      NOW,
    );
    return streakFromExpiry(v, second.toISOString());
  }

  it('UTC 跨日但只隔 1 小时 → 连击 1（本项目在 UTC+8，早 7:30 与 8:30 是同一坐）', () => {
    // 这条锁死的是按 UTC 日折叠的缺陷：日历日需要时区，而服务端不知道读者在哪个时区，
    // 证据行里也没存。同一次学习会话被算成两次复习，有效期从 +4 天虚涨到 +10 天。
    const v = deriveMastery(
      [
        gradedCorrectAt('2026-07-25T23:30:00Z', 'q1'), // 北京时间 07-26 07:30
        gradedCorrectAt('2026-07-26T00:30:00Z', 'q2'), // 北京时间 07-26 08:30
      ],
      NOW,
    );
    expect(v.state).toBe('mastered');
    expect(streakFromExpiry(v, '2026-07-26T00:30:00.000Z')).toBe(1);
  });

  it('同一自然日的晚上与次日早上（隔 12 小时）也算同一次', () => {
    expect(streakForGap(12)).toBe(1);
  });

  it('间隔恰好达到阈值即计为两次', () => {
    expect(streakForGap(STREAK_MIN_GAP_HOURS)).toBe(2);
  });

  it('差一分钟不到阈值仍算一次', () => {
    expect(streakForGap(STREAK_MIN_GAP_HOURS - 1 / 60)).toBe(1);
  });

  it('每日节律（隔 24 小时）正常累计', () => {
    expect(streakForGap(24)).toBe(2);
  });

  it('同一坐连点五下仍只算 1（原语义不回归）', () => {
    const base = NOW.getTime() - 3_600_000;
    const rows = Array.from({ length: 5 }, (_, i) =>
      gradedCorrectAt(new Date(base + i * 60_000).toISOString(), `q${i}`),
    );
    const v = deriveMastery(rows, NOW);
    expect(streakFromExpiry(v, new Date(base + 4 * 60_000).toISOString())).toBe(1);
  });

  it('输入乱序不影响连击（内部按时间排序后再扫描）', () => {
    const rows = [gradedCorrect(1, 'c'), gradedCorrect(20, 'a'), gradedCorrect(10, 'b')];
    expect(deriveMastery([...rows].reverse(), NOW)).toEqual(deriveMastery(rows, NOW));
  });

  it('过期回落 exposed 后再答对，连击不从 1 重来（「过期」≠「降档」）', () => {
    // 降档的触发条件是**答错**（strong 负证据），不是**没来**。
    // 从间隔重复的角度这是对的：间隔越长仍然答对，说明记忆越牢，值得更长的下一档。
    // 这条锁死该语义，防将来被当 bug「修」掉。
    const rows = [gradedCorrect(60, 'a'), gradedCorrect(40, 'b'), gradedCorrect(1, 'c')];
    // 中途必然经历过期（连击 2 时失效期只有 +10 天，而下一次答对在 39 天后）
    expect(deriveMastery([rows[0], rows[1]], new Date(NOW.getTime() - 20 * DAY_MS)).state)
      .toBe('exposed');
    // 再答对一次 → 连击 3（不是 1），有效期按第三档给
    const v = deriveMastery(rows, NOW);
    expect(v.state).toBe('mastered');
    expect(streakFromExpiry(v, daysAgo(1))).toBe(3);
  });

  it('lastPositiveAt 仍取最后一条正证据，不取最后一条被计数的', () => {
    // 否则同一坐的第二次答对反而会缩短有效期——反直觉。
    const first = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    const second = new Date(NOW.getTime() - 1 * 3_600_000).toISOString();
    const v = deriveMastery([gradedCorrectAt(first, 'q1'), gradedCorrectAt(second, 'q2')], NOW);
    // 连击 1 → 失效 = 最后一条正证据 + 4 天
    expect(v.expiresAt).toBe(new Date(new Date(second).getTime() + 4 * DAY_MS).toISOString());
  });
});

describe('deriveMastery：汇总字段', () => {
  it('evidenceCount / lastEvidenceAt 覆盖全部证据，不受窗口影响', () => {
    const rows = [ev('page-read', 100), ev('citation-hit', 50), gradedCorrect(1)];
    const v = deriveMastery(rows, NOW);
    expect(v.evidenceCount).toBe(3);
    expect(v.lastEvidenceAt).toBe(daysAgo(1));
  });

  it('recent 按时间倒序且截断到上限', () => {
    const rows = Array.from({ length: MAX_RECENT_EVIDENCE + 7 }, (_, i) => ev('page-read', i + 1));
    const v = deriveMastery(rows, NOW);
    expect(v.recent).toHaveLength(MAX_RECENT_EVIDENCE);
    expect(v.recent[0].createdAt).toBe(daysAgo(1));
    for (let i = 1; i < v.recent.length; i++) {
      expect(v.recent[i - 1].createdAt >= v.recent[i].createdAt).toBe(true);
    }
  });

  it('输入顺序不影响结论（派生只看时间戳）', () => {
    const rows = [gradedCorrect(20, 'q1'), gradedCorrect(10, 'q2'), gradedCorrect(1, 'q3')];
    const forward = deriveMastery(rows, NOW);
    const reversed = deriveMastery([...rows].reverse(), NOW);
    expect(reversed).toEqual(forward);
  });

  it('不修改传入数组', () => {
    const rows = [ev('page-read', 2), gradedCorrect(1)];
    const snapshot = JSON.parse(JSON.stringify(rows));
    deriveMastery(rows, NOW);
    expect(rows).toEqual(snapshot);
  });

  it('时钟回拨：未来时间戳的证据按已发生处理，不特殊化', () => {
    const v = deriveMastery([gradedCorrect(-1)], NOW);
    expect(v.state).toBe('mastered');
  });
});

describe('deriveMastery：dueAt（决策 4 两级语义的另一半）', () => {
  it('仅 mastered 时非空', () => {
    expect(deriveMastery([], NOW).dueAt).toBeNull();
    expect(deriveMastery([ev('page-read', 1)], NOW).dueAt).toBeNull();
    expect(deriveMastery([ev('quiz-wrong', 1)], NOW).dueAt).toBeNull();
    // 过期回落 exposed 的也没有 dueAt——它已经不算掌握了
    expect(deriveMastery([gradedCorrect(5)], NOW).dueAt).toBeNull();
    expect(deriveMastery([gradedCorrect(1)], NOW).dueAt).not.toBeNull();
  });

  it('dueAt 恒早于 expiresAt（复习到期 ≠ 知识失效）', () => {
    const v = deriveMastery([gradedCorrect(1)], NOW);
    expect(new Date(v.dueAt!).getTime()).toBeLessThan(new Date(v.expiresAt!).getTime());
  });

  it('dueAt = 最后一条正证据 + 该档 dueDays', () => {
    const lastAt = daysAgo(1);
    const v = deriveMastery([gradedCorrect(1)], NOW);
    const { dueDays } = masteryWindowDays(1);
    expect(v.dueAt).toBe(new Date(new Date(lastAt).getTime() + dueDays * DAY_MS).toISOString());
  });

  it('连击越长 dueAt 越远（逐档对应 masteryWindowDays）', () => {
    // 连击 3：40 / 20 / 1 天前各一条 strong 正证据（间隔远超最小间隔）
    const v = deriveMastery(
      [gradedCorrect(40, 'a'), gradedCorrect(20, 'b'), gradedCorrect(1, 'c')],
      NOW,
    );
    const { dueDays } = masteryWindowDays(3);
    expect(v.dueAt).toBe(new Date(new Date(daysAgo(1)).getTime() + dueDays * DAY_MS).toISOString());
  });
});

describe('isDueForReview（决策 4 的清单判据）', () => {
  it('mastered 且已过 dueAt → true', () => {
    // 连击 1：dueDays=1 / expiryDays=4。3 天前答对 → 已该复习、尚未失效。
    const v = deriveMastery([gradedCorrect(3)], NOW);
    expect(v.state).toBe('mastered');
    expect(isDueForReview(v, NOW)).toBe(true);
  });

  it('mastered 但未到 dueAt → false', () => {
    const v = deriveMastery([gradedCorrect(0.5)], NOW);
    expect(v.state).toBe('mastered');
    expect(isDueForReview(v, NOW)).toBe(false);
  });

  it('恰好到 dueAt 即算到期', () => {
    const v = deriveMastery([gradedCorrect(1)], NOW);
    expect(isDueForReview(v, new Date(v.dueAt!))).toBe(true);
  });

  it('已失效回落 exposed 的不进清单（清单语义是「维持已有掌握」）', () => {
    // 含失效项会让清单单调膨胀成清不完的待办，连带毁掉这个面的可信度。
    // 想找回失效的概念走 Graph 审计面。
    const v = deriveMastery([gradedCorrect(5)], NOW);
    expect(v.state).toBe('exposed');
    expect(isDueForReview(v, NOW)).toBe(false);
  });

  it('struggling / unknown 一律 false', () => {
    expect(isDueForReview(deriveMastery([ev('quiz-wrong', 1)], NOW), NOW)).toBe(false);
    expect(isDueForReview(deriveMastery([], NOW), NOW)).toBe(false);
  });
});

describe('explainMastery：与 deriveMastery 同一段逻辑（决策 7）', () => {
  const CASES: Array<[string, EvidenceRow[]]> = [
    ['无证据', []],
    ['强负证据', [ev('quiz-wrong', 1)]],
    ['两条强负证据', [ev('quiz-wrong', 2), ev('selection-ask', 1)]],
    ['strong 正证据', [gradedCorrect(1)]],
    ['两条 weak 正证据', [ev('quiz-correct', 3, { anchor: 'a' }), ev('quiz-correct', 1, { anchor: 'b' })]],
    ['孤立 weak 正证据', [ev('self-report-easy', 1)]],
    ['仅 exposure', [ev('page-read', 1)]],
    ['仅弱负证据', [ev('citation-hit', 1)]],
    ['过期正证据', [gradedCorrect(5)]],
  ];

  it.each(CASES)('%s：verdict 与 deriveMastery 深相等', (_name, rows) => {
    // 报告与线上判定共用同一段逻辑才不会漂移；两份判定必然分头演化，报告就会开始撒谎。
    expect(explainMastery(rows, NOW).verdict).toEqual(deriveMastery(rows, NOW));
  });

  it('五条优先级规则各自的序号', () => {
    expect(explainMastery([], NOW).rule).toBe(1);
    expect(explainMastery([ev('quiz-wrong', 1)], NOW).rule).toBe(2);
    expect(explainMastery([gradedCorrect(1)], NOW).rule).toBe(3);
    expect(explainMastery([ev('page-read', 1)], NOW).rule).toBe(4);
    expect(explainMastery([ev('citation-hit', 1)], NOW).rule).toBe(5);
  });

  it('blockedByStrengthGate 只在有正证据却被门槛挡下时为 true', () => {
    // 这是「mastered 恒空」的第一嫌疑：规则 3 的 strength 门槛太严。
    expect(explainMastery([ev('self-report-easy', 1)], NOW).blockedByStrengthGate).toBe(true);
    expect(explainMastery([ev('quiz-correct', 1)], NOW).blockedByStrengthGate).toBe(true);
    expect(explainMastery([gradedCorrect(1)], NOW).blockedByStrengthGate).toBe(false);
    expect(explainMastery([ev('page-read', 1)], NOW).blockedByStrengthGate).toBe(false);
  });

  it('expiredPositives 区分「门槛挡下」与「过期」两种落 exposed 的原因', () => {
    const expired = explainMastery([gradedCorrect(5)], NOW);
    expect(expired).toMatchObject({ expiredPositives: true, blockedByStrengthGate: false });

    const gated = explainMastery([ev('self-report-easy', 1)], NOW);
    expect(gated).toMatchObject({ expiredPositives: false, blockedByStrengthGate: true });
  });

  it('计数字段反映判定依据', () => {
    const e = explainMastery(
      [gradedCorrect(40, 'a'), gradedCorrect(20, 'b'), ev('self-report-easy', 1)],
      NOW,
    );
    expect(e).toMatchObject({
      consecutivePositives: 3,
      strongPositives: 2,
      weakPositives: 1,
      recentStrongNegatives: 0,
    });
  });

  it('strong 负证据清零后，计数只覆盖其后的正证据', () => {
    const e = explainMastery(
      [gradedCorrect(40, 'a'), ev('quiz-wrong', 35), gradedCorrect(30, 'b'), gradedCorrect(1, 'c')],
      NOW,
    );
    expect(e.consecutivePositives).toBe(2);
    expect(e.strongPositives).toBe(2);
    // 该强负证据已超出 NEGATIVE_WINDOW_DAYS，不再判 struggling
    expect(e.recentStrongNegatives).toBe(0);
    expect(e.rule).toBe(3);
  });
});
