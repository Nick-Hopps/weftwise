import { eq, asc } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
import { pages, wikiLinks } from '../schema';
import type { WikiPage, WikiLink } from '@/lib/contracts';

export function getAllPages(): WikiPage[] {
  const db = getDb();
  const rows = db.select().from(pages).orderBy(asc(pages.title)).all();
  return rows.map(rowToWikiPage);
}

export function getPageBySlug(slug: string): WikiPage | null {
  const db = getDb();
  const row = db.select().from(pages).where(eq(pages.slug, slug)).get();
  return row ? rowToWikiPage(row) : null;
}

export function upsertPage(page: WikiPage): WikiPage {
  const db = getDb();
  db
    .insert(pages)
    .values({
      slug: page.slug,
      title: page.title,
      path: page.path,
      summary: page.summary,
      contentHash: page.contentHash,
      tags: JSON.stringify(page.tags),
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    })
    .onConflictDoUpdate({
      target: pages.slug,
      set: {
        title: page.title,
        path: page.path,
        summary: page.summary,
        contentHash: page.contentHash,
        tags: JSON.stringify(page.tags),
        updatedAt: page.updatedAt,
      },
    })
    .run();
  return page;
}

export function deletePage(slug: string): void {
  const db = getDb();
  db.delete(wikiLinks).where(eq(wikiLinks.sourceSlug, slug)).run();
  db.delete(wikiLinks).where(eq(wikiLinks.targetSlug, slug)).run();
  db.delete(pages).where(eq(pages.slug, slug)).run();
  deleteFtsEntry(slug);
}

export function getBacklinks(slug: string): WikiPage[] {
  const db = getDb();
  const links = db
    .select()
    .from(wikiLinks)
    .where(eq(wikiLinks.targetSlug, slug))
    .all();

  const sourceSlugs = [...new Set(links.map((l) => l.sourceSlug))];
  if (sourceSlugs.length === 0) return [];

  const result: WikiPage[] = [];
  for (const sourceSlug of sourceSlugs) {
    const page = getPageBySlug(sourceSlug);
    if (page) result.push(page);
  }
  return result;
}

export interface SearchResult {
  page: WikiPage;
  snippet: string;
  rank: number;
}

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Strips FTS5 syntax characters and wraps each word in double quotes
 * so they are treated as literal terms.
 */
function sanitizeFtsQuery(input: string): string {
  const words = input
    .replace(/['"(){}^~:*\-\\]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return '';
  return words.map((w) => `"${w}"`).join(' ');
}

export function searchPages(query: string): SearchResult[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  const sqlite = getRawDb();

  const stmt = sqlite.prepare(`
    SELECT
      p.slug,
      p.title,
      p.path,
      p.summary,
      p.content_hash,
      p.tags,
      p.created_at,
      p.updated_at,
      snippet(pages_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet,
      rank
    FROM pages_fts
    JOIN pages p ON p.slug = pages_fts.slug
    WHERE pages_fts MATCH ?
    ORDER BY rank
    LIMIT 50
  `);

  const rows = stmt.all(sanitized) as Array<{
    slug: string;
    title: string;
    path: string;
    summary: string;
    content_hash: string;
    tags: string;
    created_at: string;
    updated_at: string;
    snippet: string;
    rank: number;
  }>;

  return rows.map((row) => ({
    page: {
      slug: row.slug,
      title: row.title,
      path: row.path,
      summary: row.summary ?? '',
      contentHash: row.content_hash,
      tags: safeParseJson<string[]>(row.tags, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    snippet: row.snippet,
    rank: row.rank,
  }));
}

export function updateFtsEntry(
  slug: string,
  title: string,
  summary: string,
  body: string
): void {
  const sqlite = getRawDb();
  // Delete any existing entry for this slug, then insert the new one.
  sqlite.prepare(`DELETE FROM pages_fts WHERE slug = ?`).run(slug);
  sqlite
    .prepare(
      `INSERT INTO pages_fts(title, summary, body, slug) VALUES (?, ?, ?, ?)`
    )
    .run(title, summary, body, slug);
}

export function deleteFtsEntry(slug: string): void {
  const sqlite = getRawDb();
  sqlite.prepare(`DELETE FROM pages_fts WHERE slug = ?`).run(slug);
}

/**
 * Build a map from page title (case-insensitive) to slug.
 * Used to resolve wikilink targets like [[Chinese Title]] → actual-slug.
 */
export function getTitleToSlugMap(): Map<string, string> {
  const allPages = getAllPages();
  const map = new Map<string, string>();
  for (const page of allPages) {
    map.set(page.title, page.slug);
    // Also index lowercased for case-insensitive matching
    map.set(page.title.toLowerCase(), page.slug);
  }
  return map;
}

export function getAllLinks(): WikiLink[] {
  const db = getDb();
  const rows = db.select().from(wikiLinks).all();
  return rows.map((row) => ({
    sourceSlug: row.sourceSlug,
    targetSlug: row.targetSlug,
    context: row.context ?? '',
  }));
}

export function setLinksForPage(
  sourceSlug: string,
  links: Omit<WikiLink, 'sourceSlug'>[]
): void {
  const db = getDb();
  db.delete(wikiLinks).where(eq(wikiLinks.sourceSlug, sourceSlug)).run();
  if (links.length === 0) return;
  db
    .insert(wikiLinks)
    .values(
      links.map((l) => ({
        sourceSlug,
        targetSlug: l.targetSlug,
        context: l.context,
      }))
    )
    .run();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function rowToWikiPage(row: typeof pages.$inferSelect): WikiPage {
  return {
    slug: row.slug,
    title: row.title,
    path: row.path,
    summary: row.summary ?? '',
    contentHash: row.contentHash,
    tags: safeParseJson<string[]>(row.tags ?? '[]', []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
