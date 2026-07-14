import { getRawDb } from '../db/client';
import { parseWikiPath } from './page-identity';
import type { ChangesetEntry } from '@/lib/contracts';

export interface PageIdentityMove {
  fromSlug: string;
  toSlug: string;
}

/** 从 changeset create marker 提取同 Subject 页面身份迁移。 */
export function collectPageIdentityMoves(
  subjectSlug: string,
  entries: readonly ChangesetEntry[],
): PageIdentityMove[] {
  const moves: PageIdentityMove[] = [];
  for (const entry of entries) {
    if (entry.auxiliary || entry.action !== 'create' || !entry.movedFromPath) continue;
    const from = parseWikiPath(entry.movedFromPath);
    const to = parseWikiPath(entry.path);
    if (!from || !to || from.subjectSlug !== subjectSlug || to.subjectSlug !== subjectSlug) {
      throw new Error('Page identity move must stay inside the changeset subject.');
    }
    moves.push({ fromSlug: from.slug, toSlug: to.slug });
  }
  return moves;
}

/**
 * 幂等迁移可保留的 slug-keyed 派生状态。INSERT…SELECT 在来源已迁走时零行，
 * 因而 recovery 重跑不会覆盖/删除目标状态。
 */
export function migratePageIdentityCaches(
  subjectId: string,
  move: PageIdentityMove,
): void {
  if (move.fromSlug === move.toSlug) return;
  const sqlite = getRawDb();
  const { fromSlug, toSlug } = move;

  sqlite.prepare(`
    INSERT OR IGNORE INTO page_sources (subject_id, page_slug, source_id)
    SELECT subject_id, ?, source_id FROM page_sources
    WHERE subject_id = ? AND page_slug = ?
  `).run(toSlug, subjectId, fromSlug);
  sqlite.prepare(
    `DELETE FROM page_sources WHERE subject_id = ? AND page_slug = ?`,
  ).run(subjectId, fromSlug);

  sqlite.prepare(`
    INSERT OR REPLACE INTO page_embeddings
      (subject_id, slug, model, content_hash, dim, vector, updated_at)
    SELECT subject_id, ?, model, content_hash, dim, vector, updated_at
    FROM page_embeddings WHERE subject_id = ? AND slug = ?
  `).run(toSlug, subjectId, fromSlug);
  sqlite.prepare(
    `DELETE FROM page_embeddings WHERE subject_id = ? AND slug = ?`,
  ).run(subjectId, fromSlug);

  sqlite.prepare(`
    INSERT OR REPLACE INTO page_maturity
      (subject_id, slug, passes, last_enriched_at, interval_days, next_due_at, state, priority, updated_at)
    SELECT subject_id, ?, passes, last_enriched_at, interval_days, next_due_at, state, priority, updated_at
    FROM page_maturity WHERE subject_id = ? AND slug = ?
  `).run(toSlug, subjectId, fromSlug);
  sqlite.prepare(
    `DELETE FROM page_maturity WHERE subject_id = ? AND slug = ?`,
  ).run(subjectId, fromSlug);

  sqlite.prepare(`
    INSERT OR REPLACE INTO page_renditions
      (subject_id, slug, canonical_hash, profile_version, rendered_md, model, updated_at)
    SELECT subject_id, ?, canonical_hash, profile_version, rendered_md, model, updated_at
    FROM page_renditions WHERE subject_id = ? AND slug = ?
  `).run(toSlug, subjectId, fromSlug);
  sqlite.prepare(
    `DELETE FROM page_renditions WHERE subject_id = ? AND slug = ?`,
  ).run(subjectId, fromSlug);

  sqlite.prepare(`
    UPDATE profile_signals SET slug = ?
    WHERE subject_id = ? AND slug = ?
  `).run(toSlug, subjectId, fromSlug);
}
