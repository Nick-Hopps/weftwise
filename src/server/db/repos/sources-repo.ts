import { and, eq, isNull } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
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

/** source 组合唯一身份的精确查询；写入去重不得只按 hash 猜测 filename。 */
export function getSourceByIdentity(
  subjectId: SubjectId,
  contentHash: string,
  filename: string,
): Source | null {
  const db = getDb();
  const row = db
    .select()
    .from(sources)
    .where(and(
      eq(sources.subjectId, subjectId),
      eq(sources.contentHash, contentHash),
      eq(sources.filename, filename),
    ))
    .get();
  return row ? rowToSource(row) : null;
}

/**
 * 依赖 `(subject_id, content_hash, filename)` 唯一索引收敛并发写入。
 * loser 返回 winner，调用方据此删除自己已创建的 sidecar。
 */
export function insertSourceOrGetWinner(source: Source): {
  source: Source;
  inserted: boolean;
} {
  const sqlite = getRawDb();
  const result = sqlite.prepare(`
    INSERT OR IGNORE INTO sources (
      id, subject_id, filename, content_hash, parsed_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    source.id,
    source.subjectId,
    source.filename,
    source.contentHash,
    source.parsedAt,
    source.metadataJson,
  );

  if (result.changes === 1) return { source, inserted: true };
  const winner = getSourceByIdentity(
    source.subjectId,
    source.contentHash,
    source.filename,
  );
  if (!winner) {
    throw new Error('Source 唯一冲突后未找到 canonical winner');
  }
  return { source: winner, inserted: false };
}

/** 并发 loser sidecar 删除失败时持久化精确补偿记录，由 DB 启动维护重试。 */
export function recordSourceSidecarCleanup(input: {
  loserId: string;
  winnerId: string;
  subjectSlug: string;
  filename: string;
}): void {
  const sqlite = getRawDb();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS source_dedup_cleanup (
      loser_id TEXT PRIMARY KEY NOT NULL,
      winner_id TEXT NOT NULL,
      subject_slug TEXT NOT NULL,
      filename TEXT NOT NULL
    )
  `);
  sqlite.prepare(`
    INSERT INTO source_dedup_cleanup (
      loser_id, winner_id, subject_slug, filename
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(loser_id) DO UPDATE SET
      winner_id = excluded.winner_id,
      subject_slug = excluded.subject_slug,
      filename = excluded.filename
  `).run(input.loserId, input.winnerId, input.subjectSlug, input.filename);
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

export interface PageSourceIntegrityRow {
  subjectId: SubjectId;
  pageSlug: string;
  sourceId: string;
  pageExists: boolean;
  sourceSubjectId: SubjectId | null;
}

/** 定向返回 page_sources 的两端存在性；保留悬空行供写后校验报告。 */
export function listPageSourceIntegrityRows(
  subjectId: SubjectId,
  pageSlugs: string[],
): PageSourceIntegrityRow[] {
  const uniqueSlugs = [...new Set(pageSlugs)];
  if (uniqueSlugs.length === 0) return [];

  const placeholders = uniqueSlugs.map(() => '?').join(', ');
  const rows = getRawDb()
    .prepare(
      `SELECT ps.subject_id, ps.page_slug, ps.source_id,
              CASE WHEN p.slug IS NULL THEN 0 ELSE 1 END AS page_exists,
              s.subject_id AS source_subject_id
       FROM page_sources ps
       LEFT JOIN pages p
         ON p.subject_id = ps.subject_id AND p.slug = ps.page_slug
       LEFT JOIN sources s ON s.id = ps.source_id
       WHERE ps.subject_id = ? AND ps.page_slug IN (${placeholders})
       ORDER BY ps.page_slug ASC, ps.source_id ASC`,
    )
    .all(subjectId, ...uniqueSlugs) as Array<{
      subject_id: string;
      page_slug: string;
      source_id: string;
      page_exists: number;
      source_subject_id: string | null;
    }>;

  return rows.map((row) => ({
    subjectId: row.subject_id,
    pageSlug: row.page_slug,
    sourceId: row.source_id,
    pageExists: row.page_exists === 1,
    sourceSubjectId: row.source_subject_id,
  }));
}

/**
 * Link a page to a source. Returns `true` when a new row was actually
 * inserted, `false` when the (subject, page, source) triple already existed
 * (composite PK conflict, silently ignored) — callers use this to know
 * whether the link needs compensating on rollback.
 */
export function linkPageSource(
  subjectId: SubjectId,
  pageSlug: string,
  sourceId: string
): boolean {
  const db = getDb();
  const result = db
    .insert(pageSources)
    .values({ subjectId, pageSlug, sourceId })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

/** Remove a single (subject, page, source) link — used to compensate a rolled-back changeset. */
export function unlinkPageSource(
  subjectId: SubjectId,
  pageSlug: string,
  sourceId: string
): void {
  const db = getDb();
  db
    .delete(pageSources)
    .where(
      and(
        eq(pageSources.subjectId, subjectId),
        eq(pageSources.pageSlug, pageSlug),
        eq(pageSources.sourceId, sourceId)
      )
    )
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

/** 本 subject 内没有任何 page_sources 关联的 source（孤儿候选，orphan-source 体检用）。 */
export function listUnreferencedSources(subjectId: SubjectId): Source[] {
  const db = getDb();
  const rows = db
    .select({
      id: sources.id,
      subjectId: sources.subjectId,
      filename: sources.filename,
      contentHash: sources.contentHash,
      parsedAt: sources.parsedAt,
      metadataJson: sources.metadataJson,
    })
    .from(sources)
    .leftJoin(pageSources, eq(pageSources.sourceId, sources.id))
    .where(and(eq(sources.subjectId, subjectId), isNull(pageSources.sourceId)))
    .all();
  return rows.map(rowToSource);
}

/** 删除单个 source 行（调用方负责先确认零关联并清理 raw 文件/sidecar）。 */
export function deleteSource(id: string): void {
  const db = getDb();
  db.delete(sources).where(eq(sources.id, id)).run();
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
