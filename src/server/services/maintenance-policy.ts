/**
 * 维护层策略（纯函数，易单测）。
 *
 * 用「本遍 enricher 新增 callout 数」作收敛信号替代回忆测试（§15.2）：
 *   - 大量新增（页还在长身体）→ 间隔停在当前档，慢涨；
 *   - 少量新增 → 阶梯 +1；
 *   - 零新增（saturation）→ 阶梯 +2；若已跑过 GRADUATE_AFTER_PASSES 遍 → 毕业转休眠。
 */
import type { MaturityState } from '@/lib/contracts';

export const SPACING_LADDER = [1, 3, 7, 21, 60]; // 天
const SUBSTANTIAL_INCREMENT = 3; // ≥ 视为「页还在长身体」
const GRADUATE_AFTER_PASSES = 3; // 至少跑过这么多遍才允许零增量毕业
const GRADUATED_SENTINEL_DAYS = 3650; // 毕业页 next_due 推到远期（listDue 也按 state 排除）

const CALLOUT_RE = /^>\s*\[!(intuition|example|quiz|background|diagram|pitfall)\]/gm;

export function countCallouts(md: string): number {
  const m = md.match(CALLOUT_RE);
  return m ? m.length : 0;
}

function ladderIndex(intervalDays: number): number {
  let idx = 0;
  for (let i = 0; i < SPACING_LADDER.length; i++) {
    if (SPACING_LADDER[i] <= intervalDays) idx = i;
  }
  return idx;
}

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

export interface MaturityInput {
  state: MaturityState;
  passes: number;
  intervalDays: number;
  newIncrement: number;
}

export interface MaturityNext {
  passes: number;
  intervalDays: number;
  state: MaturityState;
  nextDueAt: string;
}

export function nextMaturity(input: MaturityInput, now: Date): MaturityNext {
  const passes = input.passes + 1;
  const idx = ladderIndex(input.intervalDays);

  // 零增量 = saturation
  if (input.newIncrement <= 0) {
    if (passes >= GRADUATE_AFTER_PASSES) {
      return {
        passes,
        intervalDays: 0,
        state: 'graduated',
        nextDueAt: addDays(now, GRADUATED_SENTINEL_DAYS),
      };
    }
    const ni = Math.min(SPACING_LADDER.length - 1, idx + 2);
    return { passes, intervalDays: SPACING_LADDER[ni], state: 'active', nextDueAt: addDays(now, SPACING_LADDER[ni]) };
  }

  // 大量新增 → 停在当前档（慢涨）；少量 → +1 档
  const step = input.newIncrement >= SUBSTANTIAL_INCREMENT ? 0 : 1;
  const ni = Math.min(SPACING_LADDER.length - 1, idx + step);
  return { passes, intervalDays: SPACING_LADDER[ni], state: 'active', nextDueAt: addDays(now, SPACING_LADDER[ni]) };
}

// 正文净增字符折算为「等效 callout 数」，并入成熟度收敛信号：
// 补全阶段可能多补正文、少加 callout，若只数 callout 会误判「无进展」而过早毕业。
export const PROSE_CHARS_PER_CALLOUT = 400;

export function proseGrowthIncrement(draftContent: string, finalContent: string): number {
  const grew = finalContent.trim().length - draftContent.trim().length;
  if (grew <= 0) return 0;
  return Math.floor(grew / PROSE_CHARS_PER_CALLOUT);
}
