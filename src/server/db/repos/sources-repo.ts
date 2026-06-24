import { and, eq } from 'drizzle-orm';
import { getDb } from '../client';
import { sources, pageSources } from '../schema';
import type { Source, SubjectId } from '@/lib/contracts';

export function upsertSource(source: Source): Source {
  const db = getDb();
  db
    .insert(sources)
    .values({
      id: source.id,
      subjectId: source.subjectId,
      filename: source.filename,
      contentHash: source.contentHash,
      parsedAt: source.parsedAt,
      metadataJson: source.metadataJson,
    })
    .onConflictDoUpdate({
      target: sources.id,
      set: {
        subjectId: source.subjectId,
        filename: source.filename,
        contentHash: source.contentHash,
        parsedAt: source.parsedAt,
        metadataJson: source.metadataJson,
      },
    })
    .run();
  return source;
}

export function getSource(id: string): Source | null {
  const db = getDb();
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  return row ? rowToSource(row) : null;
}

/** All ingested source documents for a subject, newest first. */
export function listSourcesForSubject(subjectId: SubjectId): Source[] {
  const db = getDb();
  const rows = db
    .select()
    .from(sources)
    .where(eq(sources.subjectId, subjectId))
    .all();
  return rows
    .map(rowToSource)
    .sort((a, b) => (b.parsedAt ?? '').localeCompare(a.parsedAt ?? ''));
}

export function getSourceByFilename(
  subjectId: SubjectId,
  filename: string
): Source | null {
  const db = getDb();
  const row = db
    .select()
    .from(sources)
    .where(and(eq(sources.subjectId, subjectId), eq(sources.filename, filename)))
    .get();
  return row ? rowToSource(row) : null;
}

export function getSourceByHash(
  subjectId: SubjectId,
  hash: string
): Source | null {
  const db = getDb();
  const row = db
    .select()
    .from(sources)
    .where(and(eq(sources.subjectId, subjectId), eq(sources.contentHash, hash)))
    .get();
  return row ? rowToSource(row) : null;
}

export function getSourcesForPage(
  subjectId: SubjectId,
  pageSlug: string
): Source[] {
  const db = getDb();
  // 单条 JOIN 取本页关联的所有源（替代逐条 getSource 的 N+1）；
  // 悬空链接（source 已删）经 innerJoin 自然剔除，与旧实现的 if (source) 跳过一致。
  const rows = db
    .select({
      id: sources.id,
      subjectId: sources.subjectId,
      filename: sources.filename,
      contentHash: sources.contentHash,
      parsedAt: sources.parsedAt,
      metadataJson: sources.metadataJson,
    })
    .from(pageSources)
    .innerJoin(sources, eq(sources.id, pageSources.sourceId))
    .where(
      and(eq(pageSources.subjectId, subjectId), eq(pageSources.pageSlug, pageSlug))
    )
    .all();

  return rows.map(rowToSource);
}

export function linkPageSource(
  subjectId: SubjectId,
  pageSlug: string,
  sourceId: string
): void {
  const db = getDb();
  db
    .insert(pageSources)
    .values({ subjectId, pageSlug, sourceId })
    .onConflictDoNothing()
    .run();
}

export function unlinkPageSources(subjectId: SubjectId, pageSlug: string): void {
  const db = getDb();
  db
    .delete(pageSources)
    .where(
      and(eq(pageSources.subjectId, subjectId), eq(pageSources.pageSlug, pageSlug))
    )
    .run();
}

function rowToSource(row: typeof sources.$inferSelect): Source {
  return {
    id: row.id,
    subjectId: row.subjectId,
    filename: row.filename,
    contentHash: row.contentHash,
    parsedAt: row.parsedAt ?? null,
    metadataJson: row.metadataJson ?? '{}',
  };
}
