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

export interface CurateCaps {
  merge: number;
  split: number;
  delete: number;
  create: number;
}

export interface GuardDecision {
  ok: boolean;
  reason?: string;
}

export interface CurateGuard {
  canMerge(aSlug: string, bSlug: string): GuardDecision;
  canSplit(slug: string): GuardDecision;
  canDelete(slug: string): GuardDecision;
  canCreate(): GuardDecision;
  record(op: 'merge' | 'split' | 'delete' | 'create'): void;
  totals(): { merge: number; split: number; delete: number; create: number; writes: number };
}

const GUARD_META = new Set(['index', 'log']);

/**
 * 工具层硬护栏：caps 计数器 + seed 强制（auto） + auto 禁 create + 保护页。
 * seedSet=null = 手动全库（不限 scope，仍受 caps/保护页约束）。纯工厂，便于单测。
 */
export function createCurateGuard(opts: { seedSet: Set<string> | null; caps: CurateCaps }): CurateGuard {
  const { seedSet, caps } = opts;
  const counts = { merge: 0, split: 0, delete: 0, create: 0 };
  const seedOk = (slug: string) => seedSet === null || seedSet.has(slug);
  return {
    canMerge(a, b) {
      if (a === b) return { ok: false, reason: 'cannot merge a page with itself' };
      if (GUARD_META.has(a) || GUARD_META.has(b)) return { ok: false, reason: 'cannot merge a protected page (index/log)' };
      if (counts.merge >= caps.merge) return { ok: false, reason: `reached the limit of ${caps.merge} merges` };
      if (!seedOk(a) && !seedOk(b)) return { ok: false, reason: 'merge must involve a changed page in this run' };
      return { ok: true };
    },
    canSplit(slug) {
      if (GUARD_META.has(slug)) return { ok: false, reason: 'cannot split a protected page (index/log)' };
      if (counts.split >= caps.split) return { ok: false, reason: `reached the limit of ${caps.split} splits` };
      if (!seedOk(slug)) return { ok: false, reason: 'split must involve a changed page in this run' };
      return { ok: true };
    },
    canDelete(slug) {
      if (GUARD_META.has(slug)) return { ok: false, reason: 'cannot delete a protected page (index/log)' };
      if (counts.delete >= caps.delete) return { ok: false, reason: `reached the limit of ${caps.delete} deletes` };
      if (!seedOk(slug)) return { ok: false, reason: 'delete must involve a changed page in this run' };
      return { ok: true };
    },
    canCreate() {
      if (seedSet !== null) return { ok: false, reason: 'creating new pages is only allowed in manual curation' };
      if (counts.create >= caps.create) return { ok: false, reason: `reached the limit of ${caps.create} creates` };
      return { ok: true };
    },
    record(op) {
      counts[op] += 1;
    },
    totals() {
      return { ...counts, writes: counts.merge + counts.split + counts.delete + counts.create };
    },
  };
}
