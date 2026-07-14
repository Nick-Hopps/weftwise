import { eq, and, asc, min } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
import { pages, pageAliases, wikiLinks } from '../schema';
import type { WikiPage, WikiLink, SubjectId } from '@/lib/contracts';
import { normalizeSlug } from '@/lib/slug';

/**
 * Meta pages are system-generated (Index, Change Log, …) tagged with `meta`
 * in their frontmatter. They must not participate in search, graph rendering,
 * or backlink computation. They remain readable and writable by the
 * ingest/lint pipelines via explicit getPageBySlug reads.
 */
export function isMetaPage(page: Pick<WikiPage, 'tags'>): boolean {
  return (page.tags ?? []).includes('meta');
}

/**
 * Subject-scoped meta slugs as a Set keyed by `<subjectId>:<slug>`.
 */
export function getMetaPageKeys(subjectId?: SubjectId): Set<string> {
  const everyPage = subjectId ? getAllPages(subjectId) : getAllPagesAcrossSubjects();
  const keys = new Set<string>();
  for (const page of everyPage) {
    if (isMetaPage(page)) keys.add(metaKey(page.subjectId, page.slug));
  }
  return keys;
}

export function metaKey(subjectId: SubjectId, slug: string): string {
  return `${subjectId}:${slug}`;
}

export function getAllPages(subjectId: SubjectId): WikiPage[] {
  const db = getDb();
  const rows = db
    .select()
    .from(pages)
    .where(eq(pages.subjectId, subjectId))
    .orderBy(asc(pages.title))
    .all();
  return rows.map(rowToWikiPage);
}

/**
 * Cross-subject scan; primarily used by graph aggregation and meta-page indexing.
 */
export function getAllPagesAcrossSubjects(): WikiPage[] {
  const db = getDb();
  const rows = db.select().from(pages).orderBy(asc(pages.title)).all();
  return rows.map(rowToWikiPage);
}

export function getPageBySlug(subjectId: SubjectId, slug: string): WikiPage | null {
  const db = getDb();
  const row = db
    .select()
    .from(pages)
    .where(and(eq(pages.subjectId, subjectId), eq(pages.slug, slug)))
    .get();
  return row ? rowToWikiPage(row) : null;
}

export function findPageBySlugAcrossSubjects(slug: string): WikiPage[] {
  const db = getDb();
  const rows = db.select().from(pages).where(eq(pages.slug, slug)).all();
  return rows.map(rowToWikiPage);
}

export function upsertPage(page: WikiPage): WikiPage {
  const db = getDb();
  db
    .insert(pages)
    .values({
      subjectId: page.subjectId,
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
      target: [pages.subjectId, pages.slug],
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

export function deletePage(subjectId: SubjectId, slug: string): void {
  const db = getDb();
  db
    .delete(wikiLinks)
    .where(and(eq(wikiLinks.subjectId, subjectId), eq(wikiLinks.sourceSlug, slug)))
    .run();
  // Note: we keep links FROM other pages TO this slug intact so they show as broken.
  db
    .delete(pages)
    .where(and(eq(pages.subjectId, subjectId), eq(pages.slug, slug)))
    .run();
  deleteFtsEntry(subjectId, slug);
}

export function getBacklinks(subjectId: SubjectId, slug: string): WikiPage[] {
  const db = getDb();
  // 单条 JOIN 取所有指向 (subjectId, slug) 的源页（替代逐条 getPageBySlug 的 N+1）。
  // GROUP BY 源页复合 PK 去重；ORDER BY min(link.id) 保留「首现」顺序与旧实现一致；
  // 悬空链接（无对应 page 行）经 innerJoin 自然剔除；meta 源页保持在 JS 侧过滤。
  const rows = db
    .select({
      subjectId: pages.subjectId,
      slug: pages.slug,
      title: pages.title,
      path: pages.path,
      summary: pages.summary,
      contentHash: pages.contentHash,
      tags: pages.tags,
      createdAt: pages.createdAt,
      updatedAt: pages.updatedAt,
    })
    .from(wikiLinks)
    .innerJoin(
      pages,
      and(
        eq(pages.subjectId, wikiLinks.subjectId),
        eq(pages.slug, wikiLinks.sourceSlug)
      )
    )
    .where(
      and(eq(wikiLinks.targetSubjectId, subjectId), eq(wikiLinks.targetSlug, slug))
    )
    .groupBy(pages.subjectId, pages.slug)
    .orderBy(min(wikiLinks.id))
    .all();

  return rows.map(rowToWikiPage).filter((page) => !isMetaPage(page));
}

export interface SearchResult {
  page: WikiPage;
  snippet: string;
  rank: number;
}

function sanitizeFtsQuery(input: string): string {
  const words = input
    .replace(/['"(){}^~:*\-\\]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return '';
  return words.map((w) => `"${w}"`).join(' ');
}

export function searchPages(subjectId: SubjectId, query: string): SearchResult[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  const sqlite = getRawDb();
  const stmt = sqlite.prepare(`
    SELECT
      p.subject_id,
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
    JOIN pages p
      ON p.subject_id = pages_fts.subject_id
     AND p.slug       = pages_fts.slug
    WHERE pages_fts MATCH ?
      AND pages_fts.subject_id = ?
    ORDER BY rank
    LIMIT 50
  `);

  const rows = stmt.all(sanitized, subjectId) as Array<{
    subject_id: string;
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

  return rows
    .map((row) => ({
      page: {
        subjectId: row.subject_id,
        slug: row.slug,
        title: row.title,
        path: row.path,
        summary: row.summary ?? '',
        contentHash: row.content_hash,
        tags: safeParseJson<string[]>(row.tags, []),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies WikiPage,
      snippet: row.snippet,
      rank: row.rank,
    }))
    .filter((r) => !isMetaPage(r.page));
}

export function updateFtsEntry(
  subjectId: SubjectId,
  slug: string,
  title: string,
  summary: string,
  body: string
): void {
  const sqlite = getRawDb();
  sqlite
    .prepare(`DELETE FROM pages_fts WHERE subject_id = ? AND slug = ?`)
    .run(subjectId, slug);
  sqlite
    .prepare(
      `INSERT INTO pages_fts(title, summary, body, subject_id, slug) VALUES (?, ?, ?, ?, ?)`
    )
    .run(title, summary, body, subjectId, slug);
}

export function deleteFtsEntry(subjectId: SubjectId, slug: string): void {
  const sqlite = getRawDb();
  sqlite
    .prepare(`DELETE FROM pages_fts WHERE subject_id = ? AND slug = ?`)
    .run(subjectId, slug);
}

/**
 * Build a map from page title (case-insensitive) to slug, scoped to one subject.
 * Used to resolve same-subject wikilinks like [[Chinese Title]] → actual-slug.
 */
export function getTitleToSlugMap(subjectId: SubjectId): Map<string, string> {
  const allPages = getAllPages(subjectId);
  const map = new Map<string, string>();
  for (const page of allPages) {
    map.set(page.title, page.slug);
    map.set(page.title.toLowerCase(), page.slug);
  }
  const aliases = getDb()
    .select()
    .from(pageAliases)
    .where(eq(pageAliases.subjectId, subjectId))
    .all();
  for (const alias of aliases) {
    map.set(alias.oldSlug, alias.newSlug);
    map.set(alias.oldSlug.toLowerCase(), alias.newSlug);
  }
  return map;
}

/** 返回旧 slug/规范化 alias 对应的 canonical slug；不存在或自映射返回 null。 */
export function resolvePageAlias(subjectId: SubjectId, slug: string): string | null {
  const normalized = normalizeSlug(slug);
  if (!normalized) return null;
  const row = getDb()
    .select({ newSlug: pageAliases.newSlug })
    .from(pageAliases)
    .where(and(
      eq(pageAliases.subjectId, subjectId),
      eq(pageAliases.oldSlug, normalized),
    ))
    .get();
  return row && row.newSlug !== normalized ? row.newSlug : null;
}

/** 用 vault frontmatter aliases 替换一个 canonical 页面的持久化 alias 集合。 */
export function syncPageAliases(
  subjectId: SubjectId,
  canonicalSlug: string,
  aliases: readonly string[],
  createdAt = new Date().toISOString(),
): void {
  const sqlite = getRawDb();
  sqlite.prepare(
    `DELETE FROM page_aliases WHERE subject_id = ? AND new_slug = ?`,
  ).run(subjectId, canonicalSlug);

  const normalized = [...new Set(aliases.map(normalizeSlug))]
    .filter((alias) => alias && alias !== canonicalSlug);
  const insert = sqlite.prepare(`
    INSERT INTO page_aliases (subject_id, old_slug, new_slug, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(subject_id, old_slug) DO UPDATE SET
      new_slug = excluded.new_slug,
      created_at = excluded.created_at
  `);
  for (const alias of normalized) {
    insert.run(subjectId, alias, canonicalSlug, createdAt);
  }
}

/** 页面删除时移除所有指向该 canonical slug 的 alias。 */
export function deletePageAliases(subjectId: SubjectId, canonicalSlug: string): void {
  getRawDb().prepare(
    `DELETE FROM page_aliases WHERE subject_id = ? AND new_slug = ?`,
  ).run(subjectId, canonicalSlug);
}

export function getAllLinks(
  subjectId?: SubjectId,
  metaKeys?: Set<string>
): WikiLink[] {
  const db = getDb();
  const rows = subjectId
    ? db.select().from(wikiLinks).where(eq(wikiLinks.subjectId, subjectId)).all()
    : db.select().from(wikiLinks).all();
  // metaKeys 可由调用方预先计算并复用（避免每次调用都做一次跨主题 getMetaPageKeys 全表扫描）。
  const keys = metaKeys ?? getMetaPageKeys();
  return rows
    .filter(
      (row) =>
        !keys.has(metaKey(row.subjectId, row.sourceSlug)) &&
        !keys.has(metaKey(row.targetSubjectId, row.targetSlug))
    )
    .map((row) => ({
      subjectId: row.subjectId,
      sourceSlug: row.sourceSlug,
      targetSubjectId: row.targetSubjectId,
      targetSlug: row.targetSlug,
      context: row.context ?? '',
    }));
}

export interface OutgoingLink {
  targetSubjectId: SubjectId;
  targetSlug: string;
  context: string;
}

export function setLinksForPage(
  subjectId: SubjectId,
  sourceSlug: string,
  links: OutgoingLink[]
): void {
  const db = getDb();
  db
    .delete(wikiLinks)
    .where(
      and(eq(wikiLinks.subjectId, subjectId), eq(wikiLinks.sourceSlug, sourceSlug))
    )
    .run();
  if (links.length === 0) return;
  db
    .insert(wikiLinks)
    .values(
      links.map((l) => ({
        subjectId,
        sourceSlug,
        targetSubjectId: l.targetSubjectId,
        targetSlug: l.targetSlug,
        context: l.context,
      }))
    )
    .run();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function rowToWikiPage(row: typeof pages.$inferSelect): WikiPage {
  return {
    subjectId: row.subjectId,
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
