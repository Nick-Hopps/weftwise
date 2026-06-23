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
import * as maturityRepo from '../db/repos/maturity-repo';
import { getRawDb } from '../db/client';
import type { WikiPage, SubjectId, Subject } from '@/lib/contracts';
import type { TitleResolver, ExtractedLink } from './wikilinks';

/** 由系统自动生成、不参与成熟度维护的 meta 页 slug 集合。 */
const META_SLUGS = new Set(['index', 'log']);

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

/** 收集与 slug 相邻的页（本 subject 内 backlink 源 ∪ 出链目标），去重、排除自身。 */
export function collectNeighborSlugs(
  subjectId: SubjectId,
  slug: string,
): { subjectId: SubjectId; slug: string }[] {
  const db = getRawDb();
  const backlinkSources = db
    .prepare(
      `SELECT DISTINCT source_slug AS s FROM wiki_links WHERE subject_id = ? AND target_subject_id = ? AND target_slug = ?`,
    )
    .all(subjectId, subjectId, slug) as Array<{ s: string }>;
  const outgoing = db
    .prepare(
      `SELECT DISTINCT target_slug AS s FROM wiki_links WHERE subject_id = ? AND source_slug = ? AND target_subject_id = ?`,
    )
    .all(subjectId, slug, subjectId) as Array<{ s: string }>;
  const seen = new Set<string>();
  const out: { subjectId: SubjectId; slug: string }[] = [];
  for (const r of [...backlinkSources, ...outgoing]) {
    if (r.s === slug || seen.has(r.s)) continue;
    seen.add(r.s);
    out.push({ subjectId, slug: r.s });
  }
  return out;
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

  // P5 维护层：为本批页建成熟度行 + 按 wiki_links 邻居唤醒相关旧页（整合新知识）。
  // index/log 为系统自动生成的 meta 页，不参与成熟度调度，跳过初始化与邻居唤醒。
  const MAINTENANCE_INITIAL_INTERVAL_DAYS = 1;
  const now = new Date().toISOString();
  for (const slug of presentSlugs) {
    if (META_SLUGS.has(slug)) continue;
    maturityRepo.ensureRow(subjectId, slug, now, MAINTENANCE_INITIAL_INTERVAL_DAYS);
    for (const nb of collectNeighborSlugs(subjectId, slug)) {
      maturityRepo.bumpNeighbor(nb.subjectId, nb.slug, now);
    }
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
