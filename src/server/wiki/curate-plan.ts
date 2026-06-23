/**
 * 页面策展纯逻辑：scope 邻居扩展 + 决策上限截断。无 I/O，便于单测。
 */
import type { CurateTriage } from '../llm/prompts/curate-prompt';

export interface CurateLimits {
  maxMerges: number;
  maxSplits: number;
}

/**
 * 把受影响页 slug 集合扩展到其「本-subject 邻居」：
 *  - 反链源：指向 seed 的页（link.targetSlug ∈ seed）→ 加 link.sourceSlug
 *  - 正链目标：seed 指向的页（link.sourceSlug ∈ seed）→ 加 link.targetSlug
 * 仅计本-subject 链接（targetSubjectId === subjectId），排除 meta，去重。
 */
export function expandScopeWithNeighbors(
  seedSlugs: string[],
  links: { sourceSlug: string; targetSlug: string; targetSubjectId: string }[],
  subjectId: string,
  metaSlugs: Set<string>,
): string[] {
  const seed = new Set(seedSlugs);
  const out = new Set(seedSlugs);
  for (const l of links) {
    if (l.targetSubjectId !== subjectId) continue;
    if (seed.has(l.targetSlug)) out.add(l.sourceSlug);
    if (seed.has(l.sourceSlug)) out.add(l.targetSlug);
  }
  return [...out].filter((s) => !metaSlugs.has(s));
}

/**
 * auto 路径护栏：只保留「至少含一个 seed（本次受影响）页」的候选。
 * seedSet 为 null（手动全库路径）时原样放行。返回保留集 + 被丢弃的候选（供 emit skip）。
 */
export function restrictToSeed(
  decisions: CurateTriage,
  seedSet: Set<string> | null,
): {
  kept: CurateTriage;
  droppedMerges: CurateTriage['merges'];
  droppedSplits: CurateTriage['splits'];
} {
  if (!seedSet) return { kept: decisions, droppedMerges: [], droppedSplits: [] };
  const mergeHasSeed = (m: CurateTriage['merges'][number]) => seedSet.has(m.aSlug) || seedSet.has(m.bSlug);
  const splitHasSeed = (s: CurateTriage['splits'][number]) => seedSet.has(s.slug);
  return {
    kept: {
      merges: decisions.merges.filter(mergeHasSeed),
      splits: decisions.splits.filter(splitHasSeed),
    },
    droppedMerges: decisions.merges.filter((m) => !mergeHasSeed(m)),
    droppedSplits: decisions.splits.filter((s) => !splitHasSeed(s)),
  };
}

/** 截断 triage 候选到上限内，返回保留集合与各自丢弃数。 */
export function applyDecisionCaps(
  triage: CurateTriage,
  limits: CurateLimits,
): { kept: CurateTriage; droppedMerges: number; droppedSplits: number } {
  const merges = triage.merges.slice(0, limits.maxMerges);
  const splits = triage.splits.slice(0, limits.maxSplits);
  return {
    kept: { merges, splits },
    droppedMerges: triage.merges.length - merges.length,
    droppedSplits: triage.splits.length - splits.length,
  };
}
