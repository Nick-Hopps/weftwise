/**
 * SQLite index update utilities.
 * Handles incremental (touched-slug) and full-rebuild indexing of wiki pages.
 */

import { createHash } from 'crypto';
import { readPageBySlug, scanWikiPages } from './wiki-store';
import { wikiPathFromSlug } from './page-identity';
import { parseFrontmatter } from './frontmatter';
import * as pagesRepo from '../db/repos/pages-repo';
import { getRawDb } from '../db/client';
import type { WikiPage } from '@/lib/contracts';
import type { TitleResolver } from './wikilinks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a short SHA-256 prefix for a block of content.
 * Used as the `contentHash` field on WikiPage rows.
 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Build a WikiPage record from parsed document data and raw file content.
 */
function buildWikiPage(
  slug: string,
  rawContent: string,
  frontmatter: {
    title: string;
    created: string;
    updated: string;
    tags: string[];
    summary?: string;
  }
): WikiPage {
  return {
    slug,
    title: frontmatter.title || slug,
    path: wikiPathFromSlug(slug),
    summary: frontmatter.summary ?? '',
    contentHash: contentHash(rawContent),
    tags: frontmatter.tags ?? [],
    createdAt: frontmatter.created || new Date().toISOString(),
    updatedAt: frontmatter.updated || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a TitleResolver from the current pages in the database.
 * Matches page titles case-insensitively so that wikilinks like
 * [[JavaScript 闭包原理与应用]] resolve to the correct slug.
 */
function buildTitleResolver(): TitleResolver {
  const titleMap = pagesRepo.getTitleToSlugMap();
  return (title: string) => titleMap.get(title) ?? titleMap.get(title.toLowerCase());
}

/**
 * Update the SQLite index for the specified slugs only.
 *
 * For each slug:
 * - If the wiki file exists: upsert the page row, update the FTS entry, and
 *   replace wiki_links for this page.
 * - If the file has been deleted: remove the page row, FTS entry, and any
 *   outgoing wiki_links.
 */
export function indexTouchedPages(slugs: string[]): void {
  if (slugs.length === 0) return;

  const resolver = buildTitleResolver();

  for (const slug of slugs) {
    const doc = readPageBySlug(slug, resolver);

    if (doc === null) {
      // File was deleted — clean up all traces
      pagesRepo.deletePage(slug);
      pagesRepo.deleteFtsEntry(slug);
    } else {
      const rawContent = JSON.stringify(doc.frontmatter) + doc.body;
      const page = buildWikiPage(slug, rawContent, doc.frontmatter);

      pagesRepo.upsertPage(page);
      pagesRepo.updateFtsEntry(slug, page.title, page.summary, doc.body);
      pagesRepo.setLinksForPage(
        slug,
        doc.links.map((link) => ({ targetSlug: link.target, context: link.raw }))
      );
    }
  }
}

/**
 * Full rebuild of the pages + wiki_links tables.
 *
 * Uses a two-pass approach:
 * 1. Scan and insert all pages (to build a complete title→slug map).
 * 2. Re-extract and store wikilinks using the title resolver.
 */
export function rebuildPageIndex(): void {
  const sqlite = getRawDb();
  const pages = scanWikiPages();

  const rebuild = sqlite.transaction(() => {
    sqlite.exec('DELETE FROM pages_fts');
    sqlite.exec('DELETE FROM wiki_links');
    sqlite.exec('DELETE FROM pages');

    // Pass 1 — upsert every page so the title→slug map is complete
    for (const { slug, content } of pages) {
      const { data: frontmatter } = parseFrontmatter(content);
      const page = buildWikiPage(slug, content, frontmatter);
      pagesRepo.upsertPage(page);
      pagesRepo.updateFtsEntry(slug, page.title, page.summary, content);
    }

    // Pass 2 — resolve wikilinks with the full title map
    const resolver = buildTitleResolver();
    for (const { slug } of pages) {
      const doc = readPageBySlug(slug, resolver);
      if (!doc) continue;
      pagesRepo.setLinksForPage(
        slug,
        doc.links.map((link) => ({ targetSlug: link.target, context: link.raw }))
      );
    }
  });
  rebuild();
}

/**
 * Rebuild the FTS5 search index from the current pages table contents.
 *
 * Steps:
 * 1. Truncate the pages_fts virtual table.
 * 2. Re-insert every page's title, summary, and body.
 */
export function rebuildSearchIndex(): void {
  const sqlite = getRawDb();

  sqlite.exec('DELETE FROM pages_fts');

  const pages = scanWikiPages();
  for (const { slug } of pages) {
    const doc = readPageBySlug(slug);
    if (!doc) continue;

    pagesRepo.updateFtsEntry(
      slug,
      doc.frontmatter.title || slug,
      doc.frontmatter.summary ?? '',
      doc.body
    );
  }
}
