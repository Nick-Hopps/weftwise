import { and, eq } from 'drizzle-orm';
import { getDb } from '../client';
import { pageRenditions } from '../schema';

/** 命中要求 hash 与 profileVersion 都匹配；否则视为过期返回 null。 */
export function getRendition(
  subjectId: string,
  slug: string,
  canonicalHash: string,
  profileVersion: number,
): string | null {
  const row = getDb()
    .select()
    .from(pageRenditions)
    .where(and(eq(pageRenditions.subjectId, subjectId), eq(pageRenditions.slug, slug)))
    .get();
  if (!row) return null;
  if (row.canonicalHash !== canonicalHash || row.profileVersion !== profileVersion) return null;
  return row.renderedMd;
}

export function upsertRendition(row: {
  subjectId: string;
  slug: string;
  canonicalHash: string;
  profileVersion: number;
  renderedMd: string;
  model: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .insert(pageRenditions)
    .values({ ...row, updatedAt: now })
    .onConflictDoUpdate({
      target: [pageRenditions.subjectId, pageRenditions.slug],
      set: {
        canonicalHash: row.canonicalHash,
        profileVersion: row.profileVersion,
        renderedMd: row.renderedMd,
        model: row.model,
        updatedAt: now,
      },
    })
    .run();
}

export function deleteBySubject(subjectId: string): void {
  getDb().delete(pageRenditions).where(eq(pageRenditions.subjectId, subjectId)).run();
}
