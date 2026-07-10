/**
 * 页面策展纯逻辑：scope 邻居扩展 + tool-loop 硬护栏。无 I/O，便于单测。
 */

import { META_PAGE_SLUGS } from './page-identity';

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
  metaSlugs: ReadonlySet<string>,
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
  isAllowed(slug: string): boolean;
  canMerge(aSlug: string, bSlug: string): GuardDecision;
  canSplit(slug: string): GuardDecision;
  canDelete(slug: string): GuardDecision;
  canCreate(): GuardDecision;
  record(op: 'merge' | 'split' | 'delete' | 'create'): void;
  totals(): { merge: number; split: number; delete: number; create: number; writes: number };
}

/**
 * 工具层硬护栏：caps 计数器 + seed 强制（auto） + auto 禁 create + 保护页。
 * seedSet=null = 手动全库（不限 scope，仍受 caps/保护页约束）。纯工厂，便于单测。
 */
export function createCurateGuard(opts: {
  seedSet: Set<string> | null;
  allowedSet: Set<string>;
  caps: CurateCaps;
}): CurateGuard {
  const { seedSet, allowedSet, caps } = opts;
  const counts = { merge: 0, split: 0, delete: 0, create: 0 };
  const seedOk = (slug: string) => seedSet === null || seedSet.has(slug);
  return {
    isAllowed(slug) {
      return allowedSet.has(slug);
    },
    canMerge(a, b) {
      if (a === b) return { ok: false, reason: 'cannot merge a page with itself' };
      if (META_PAGE_SLUGS.has(a) || META_PAGE_SLUGS.has(b)) return { ok: false, reason: 'cannot merge a protected page (index/log)' };
      if (counts.merge >= caps.merge) return { ok: false, reason: `reached the limit of ${caps.merge} merges` };
      if (!allowedSet.has(a) || !allowedSet.has(b)) return { ok: false, reason: 'both merge targets must be inside the allowed scope' };
      if (!seedOk(a) && !seedOk(b)) return { ok: false, reason: 'merge must involve a changed page in this run' };
      return { ok: true };
    },
    canSplit(slug) {
      if (META_PAGE_SLUGS.has(slug)) return { ok: false, reason: 'cannot split a protected page (index/log)' };
      if (counts.split >= caps.split) return { ok: false, reason: `reached the limit of ${caps.split} splits` };
      if (!allowedSet.has(slug)) return { ok: false, reason: 'split target must be inside the allowed scope' };
      if (!seedOk(slug)) return { ok: false, reason: 'split must involve a changed page in this run' };
      return { ok: true };
    },
    canDelete(slug) {
      if (META_PAGE_SLUGS.has(slug)) return { ok: false, reason: 'cannot delete a protected page (index/log)' };
      if (counts.delete >= caps.delete) return { ok: false, reason: `reached the limit of ${caps.delete} deletes` };
      if (!allowedSet.has(slug)) return { ok: false, reason: 'delete target must be inside the allowed scope' };
      if (seedSet !== null) return { ok: false, reason: 'automatic curation cannot delete pages' };
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
