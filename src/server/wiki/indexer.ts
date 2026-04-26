/**
 * SQLite index update utilities.
 * Handles incremental (touched-slug) and full-rebuild indexing of wiki pages.
 */

import { createHash } from 'crypto';
import { readPageInSubject, scanWikiPages } from './wiki-store';
import { buildWikiPath } from './page-identity';
import { parseFrontmatter } from './frontmatter';
import * as pagesRepo from '../db/repos/pages-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { getRawDb } from '../db/client';
import type { WikiPage, SubjectId, Subject } from '@/lib/contracts';
import type { TitleResolver, ExtractedLink } from './wikilinks';

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

interface SubjectAwareFrontmatter {
  title: string;
  created: string;
  updated: string;
  tags: string[];
  summary?: string;
}

function buildWikiPage(
  subjectId: SubjectId,
  subjectSlug: string,
  slug: string,
  rawContent: string,
  frontmatter: SubjectAwareFrontmatter
): WikiPage {
  return {
    subjectId,
    slug,
    title: frontmatter.title || slug,
    path: buildWikiPath(subjectSlug, slug),
    summary: frontmatter.summary ?? '',
    contentHash: contentHash(rawContent),
    tags: frontmatter.tags ?? [],
    createdAt: frontmatter.created || new Date().toISOString(),
    updatedAt: frontmatter.updated || new Date().toISOString(),
  };
}

function buildTitleResolver(subjectId: SubjectId): TitleResolver {
  const titleMap = pagesRepo.getTitleToSlugMap(subjectId);
  return (title: string) => titleMap.get(title) ?? titleMap.get(title.toLowerCase());
}

function resolveLinkTargetSubject(
  link: ExtractedLink,
  fallbackSubject: Subject
): { targetSubjectId: SubjectId; targetSlug: string } | null {
  const { targetSubjectSlug, target } = link;
  if (!targetSubjectSlug || targetSubjectSlug === fallbackSubject.slug) {
    return { targetSubjectId: fallbackSubject.id, targetSlug: target };
  }
  const targetSubject = subjectsRepo.getBySlug(targetSubjectSlug);
  if (!targetSubject) return null;
  return { targetSubjectId: targetSubject.id, targetSlug: target };
}

/**
 * Update the SQLite index for a set of slugs within a single subject.
 *
 * Two passes so wikilinks between pages in the SAME batch resolve correctly:
 * 1. Upsert every page row + FTS entry (or delete missing files), so the
 *    title→slug map seen in pass 2 is complete for the touched batch.
 * 2. Re-extract wikilinks against the up-to-date title map and replace each
 *    page's outgoing links.
 *
 * Without the two passes, a fresh batch of pages whose bodies cite each other
 * by title (common with non-ASCII / Chinese titles) loses every cross-link to
 * `normalizeSlug` fallback, which strips most non-ASCII content.
 */
export function indexTouchedPages(subjectId: SubjectId, slugs: string[]): void {
  if (slugs.length === 0) return;
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) return;

  const presentSlugs: string[] = [];

  // Pass 1 — upsert pages / FTS, or delete missing files. No wikilink resolution
  // yet: the resolver built in pass 2 must see every freshly-upserted title.
  for (const slug of slugs) {
    const doc = readPageInSubject(subject.slug, slug, {
      currentSubjectSlug: subject.slug,
    });

    if (doc === null) {
      pagesRepo.deletePage(subjectId, slug);
      continue;
    }

    const rawContent = JSON.stringify(doc.frontmatter) + doc.body;
    const page = buildWikiPage(subjectId, subject.slug, slug, rawContent, doc.frontmatter);

    pagesRepo.upsertPage(page);
    pagesRepo.updateFtsEntry(subjectId, slug, page.title, page.summary, doc.body);
    presentSlugs.push(slug);
  }

  // Pass 2 — resolve wikilinks with a title map that now includes the batch.
  const resolver = buildTitleResolver(subjectId);
  for (const slug of presentSlugs) {
    const doc = readPageInSubject(subject.slug, slug, {
      currentSubjectSlug: subject.slug,
      titleResolver: resolver,
    });
    if (!doc) continue;

    const outgoing = doc.links
      .map((link) => {
        const resolved = resolveLinkTargetSubject(link, subject);
        if (!resolved) return null;
        return { ...resolved, context: link.raw };
      })
      .filter((l): l is { targetSubjectId: SubjectId; targetSlug: string; context: string } => l !== null);

    pagesRepo.setLinksForPage(subjectId, slug, outgoing);
  }
}

/**
 * Full rebuild of the pages + wiki_links tables across all subjects.
 *
 * Two-pass per subject:
 * 1. Upsert every page so the title→slug map is complete.
 * 2. Re-extract and store wikilinks using the title resolver.
 */
export function rebuildPageIndex(): void {
  const sqlite = getRawDb();

  const rebuild = sqlite.transaction(() => {
    sqlite.exec('DELETE FROM pages_fts');
    sqlite.exec('DELETE FROM wiki_links');
    sqlite.exec('DELETE FROM pages');

    const allSubjects = subjectsRepo.listSubjects();
    const scanned = scanWikiPages();

    // Group scanned pages by subject slug
    const bySubject = new Map<string, typeof scanned>();
    for (const entry of scanned) {
      const existing = bySubject.get(entry.subjectSlug) ?? [];
      existing.push(entry);
      bySubject.set(entry.subjectSlug, existing);
    }

    // Pass 1 — upsert pages and FTS rows for every known subject
    for (const subject of allSubjects) {
      const entries = bySubject.get(subject.slug) ?? [];
      for (const entry of entries) {
        const { data: frontmatter } = parseFrontmatter(entry.content);
        const page = buildWikiPage(
          subject.id,
          subject.slug,
          entry.slug,
          entry.content,
          frontmatter
        );
        pagesRepo.upsertPage(page);
        pagesRepo.updateFtsEntry(
          subject.id,
          entry.slug,
          page.title,
          page.summary,
          entry.content
        );
      }
    }

    // Pass 2 — resolve wikilinks with full title maps
    for (const subject of allSubjects) {
      const resolver = buildTitleResolver(subject.id);
      const entries = bySubject.get(subject.slug) ?? [];
      for (const entry of entries) {
        const doc = readPageInSubject(subject.slug, entry.slug, {
          currentSubjectSlug: subject.slug,
          titleResolver: resolver,
        });
        if (!doc) continue;

        const outgoing = doc.links
          .map((link) => {
            const resolved = resolveLinkTargetSubject(link, subject);
            if (!resolved) return null;
            return { ...resolved, context: link.raw };
          })
          .filter((l): l is { targetSubjectId: SubjectId; targetSlug: string; context: string } => l !== null);

        pagesRepo.setLinksForPage(subject.id, entry.slug, outgoing);
      }
    }
  });
  rebuild();
}

/**
 * Rebuild the FTS5 search index from the on-disk vault.
 */
export function rebuildSearchIndex(): void {
  const sqlite = getRawDb();
  sqlite.exec('DELETE FROM pages_fts');

  const allSubjects = subjectsRepo.listSubjects();
  const scanned = scanWikiPages();

  for (const subject of allSubjects) {
    const entries = scanned.filter((e) => e.subjectSlug === subject.slug);
    for (const entry of entries) {
      const doc = readPageInSubject(subject.slug, entry.slug, {
        currentSubjectSlug: subject.slug,
      });
      if (!doc) continue;
      pagesRepo.updateFtsEntry(
        subject.id,
        entry.slug,
        doc.frontmatter.title || entry.slug,
        doc.frontmatter.summary ?? '',
        doc.body
      );
    }
  }
}
