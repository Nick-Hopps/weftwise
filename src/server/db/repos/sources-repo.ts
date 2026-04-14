import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import { sources, pageSources } from '../schema';
import type { Source } from '@/lib/contracts';

export function upsertSource(source: Source): Source {
  const db = getDb();
  db
    .insert(sources)
    .values({
      id: source.id,
      filename: source.filename,
      contentHash: source.contentHash,
      parsedAt: source.parsedAt,
      metadataJson: source.metadataJson,
    })
    .onConflictDoUpdate({
      target: sources.id,
      set: {
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

export function getSourceByFilename(filename: string): Source | null {
  const db = getDb();
  const row = db
    .select()
    .from(sources)
    .where(eq(sources.filename, filename))
    .get();
  return row ? rowToSource(row) : null;
}

export function getSourceByHash(hash: string): Source | null {
  const db = getDb();
  const row = db
    .select()
    .from(sources)
    .where(eq(sources.contentHash, hash))
    .get();
  return row ? rowToSource(row) : null;
}

export function getSourcesForPage(pageSlug: string): Source[] {
  const db = getDb();
  const links = db
    .select()
    .from(pageSources)
    .where(eq(pageSources.pageSlug, pageSlug))
    .all();

  const result: Source[] = [];
  for (const link of links) {
    const source = getSource(link.sourceId);
    if (source) result.push(source);
  }
  return result;
}

export function linkPageSource(pageSlug: string, sourceId: string): void {
  const db = getDb();
  db
    .insert(pageSources)
    .values({ pageSlug, sourceId })
    .onConflictDoNothing()
    .run();
}

export function unlinkPageSources(pageSlug: string): void {
  const db = getDb();
  db.delete(pageSources).where(eq(pageSources.pageSlug, pageSlug)).run();
}

// ── helpers ───────────────────────────────────────────────────────────────────

function rowToSource(row: typeof sources.$inferSelect): Source {
  return {
    id: row.id,
    filename: row.filename,
    contentHash: row.contentHash,
    parsedAt: row.parsedAt ?? null,
    metadataJson: row.metadataJson ?? '{}',
  };
}
