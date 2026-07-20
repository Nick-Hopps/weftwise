import { getRawDb } from '../client';
import type { PageMaturity, MaturityState, MaintenanceDuePage } from '@/lib/contracts';

interface RawRow {
  subject_id: string;
  slug: string;
  passes: number;
  last_enriched_at: string | null;
  interval_days: number;
  next_due_at: string;
  state: string;
  priority: number;
  updated_at: string;
}

function toDomain(r: RawRow): PageMaturity {
  return {
    subjectId: r.subject_id,
    slug: r.slug,
    passes: r.passes,
    lastEnrichedAt: r.last_enriched_at,
    intervalDays: r.interval_days,
    nextDueAt: r.next_due_at,
    state: r.state as MaturityState,
    priority: r.priority,
    updatedAt: r.updated_at,
  };
}

export function get(subjectId: string, slug: string): PageMaturity | null {
  const row = getRawDb()
    .prepare(`SELECT * FROM page_maturity WHERE subject_id = ? AND slug = ?`)
    .get(subjectId, slug) as RawRow | undefined;
  return row ? toDomain(row) : null;
}

/** 新页入场：不存在则建行（active，next_due = now + initialIntervalDays）；已存在不动。 */
export function ensureRow(
  subjectId: string,
  slug: string,
  nowIso: string,
  initialIntervalDays: number,
): void {
  const nextDue = new Date(
    new Date(nowIso).getTime() + initialIntervalDays * 86_400_000,
  ).toISOString();
  getRawDb()
    .prepare(
      `INSERT INTO page_maturity
         (subject_id, slug, passes, last_enriched_at, interval_days, next_due_at, state, priority, updated_at)
       VALUES (?, ?, 0, NULL, ?, ?, 'active', 0, ?)
       ON CONFLICT(subject_id, slug) DO NOTHING`,
    )
    .run(subjectId, slug, initialIntervalDays, nextDue, nowIso);
}

/** 查询到期且未毕业的页面，按 priority DESC，next_due_at ASC 排序。 */
export function listDue(
  nowIso: string,
  limit: number,
  subjectIds?: readonly string[],
): { subjectId: string; slug: string }[] {
  if (subjectIds?.length === 0) return [];
  const scopeClause = subjectIds
    ? ` AND subject_id IN (${subjectIds.map(() => '?').join(', ')})`
    : '';
  const rows = getRawDb()
    .prepare(
      `SELECT subject_id, slug FROM page_maturity
       WHERE state != 'graduated' AND next_due_at <= ?
       ${scopeClause}
       ORDER BY priority DESC, next_due_at ASC
       LIMIT ?`,
    )
    .all(nowIso, ...(subjectIds ?? []), limit) as Array<{ subject_id: string; slug: string }>;
  return rows.map((r) => ({ subjectId: r.subject_id, slug: r.slug }));
}

/**
 * 到期页面明细（供 UI 预览）：WHERE/ORDER 与 listDue 完全一致，另 JOIN
 * pages 取标题、subjects 取 slug/name。pages 用 LEFT JOIN 容忍 maturity
 * 孤儿行（页已删未 prune），保证明细与 countDue 口径不漂移。
 */
export function listDueDetailed(
  nowIso: string,
  limit: number,
  subjectIds?: readonly string[],
): MaintenanceDuePage[] {
  if (subjectIds?.length === 0) return [];
  const scopeClause = subjectIds
    ? ` AND m.subject_id IN (${subjectIds.map(() => '?').join(', ')})`
    : '';
  const rows = getRawDb()
    .prepare(
      `SELECT m.subject_id, m.slug, m.next_due_at, m.priority, m.state,
              p.title, s.slug AS subject_slug, s.name AS subject_name
       FROM page_maturity m
       JOIN subjects s ON s.id = m.subject_id
       LEFT JOIN pages p ON p.subject_id = m.subject_id AND p.slug = m.slug
       WHERE m.state != 'graduated' AND m.next_due_at <= ?
       ${scopeClause}
       ORDER BY m.priority DESC, m.next_due_at ASC
       LIMIT ?`,
    )
    .all(nowIso, ...(subjectIds ?? []), limit) as Array<{
      subject_id: string;
      slug: string;
      next_due_at: string;
      priority: number;
      state: string;
      title: string | null;
      subject_slug: string;
      subject_name: string;
    }>;
  return rows.map((r) => ({
    subjectId: r.subject_id,
    subjectSlug: r.subject_slug,
    subjectName: r.subject_name,
    slug: r.slug,
    title: r.title,
    nextDueAt: r.next_due_at,
    priority: r.priority,
    state: r.state as MaturityState,
  }));
}

/** 统计范围内到期且未毕业的页数；subjectIds 缺省为全量，与调度器 sweep 同口径。 */
export function countDue(nowIso: string, subjectIds?: readonly string[]): number {
  if (subjectIds?.length === 0) return 0;
  const scopeClause = subjectIds
    ? ` AND subject_id IN (${subjectIds.map(() => '?').join(', ')})`
    : '';
  const row = getRawDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM page_maturity
       WHERE state != 'graduated' AND next_due_at <= ?
       ${scopeClause}`,
    )
    .get(nowIso, ...(subjectIds ?? [])) as { n: number };
  return row.n;
}

/** re-enrich 跑完回写：推进 passes/interval/state/next_due，重置 priority=0，记 last_enriched_at。 */
export function applyAfterEnrich(
  subjectId: string,
  slug: string,
  next: { passes: number; intervalDays: number; state: MaturityState; nextDueAt: string },
  nowIso: string,
): void {
  getRawDb()
    .prepare(
      `INSERT INTO page_maturity
         (subject_id, slug, passes, last_enriched_at, interval_days, next_due_at, state, priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(subject_id, slug) DO UPDATE SET
         passes = excluded.passes,
         last_enriched_at = excluded.last_enriched_at,
         interval_days = excluded.interval_days,
         next_due_at = excluded.next_due_at,
         state = excluded.state,
         priority = 0,
         updated_at = excluded.updated_at`,
    )
    .run(subjectId, slug, next.passes, nowIso, next.intervalDays, next.nextDueAt, next.state, nowIso);
}

/** 事件唤醒：邻居 priority+1、提前到期（MIN 取较早值）、复活 dormant/graduated → active。 */
export function bumpNeighbor(subjectId: string, slug: string, nowIso: string): void {
  getRawDb()
    .prepare(
      `UPDATE page_maturity SET
         priority = priority + 1,
         next_due_at = MIN(next_due_at, ?),
         state = 'active', -- dormant/graduated → active（唤醒复活）
         updated_at = ?
       WHERE subject_id = ? AND slug = ?`,
    )
    .run(nowIso, nowIso, subjectId, slug);
}

/** 删孤儿行（slug 不在 liveSlugs 中），供索引时清理；可选调用。 */
export function pruneOrphans(subjectId: string, liveSlugs: string[]): void {
  const db = getRawDb();
  const all = db
    .prepare(`SELECT slug FROM page_maturity WHERE subject_id = ?`)
    .all(subjectId) as { slug: string }[];
  const live = new Set(liveSlugs);
  const del = db.prepare(`DELETE FROM page_maturity WHERE subject_id = ? AND slug = ?`);
  for (const { slug } of all) {
    if (!live.has(slug)) del.run(subjectId, slug);
  }
}
