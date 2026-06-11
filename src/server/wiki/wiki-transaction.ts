/**
 * Transactional wiki changeset execution using the Saga pattern.
 *
 * Flow:
 *   createChangeset → validateChangeset → applyChangeset
 *                                             ↓ (on error)
 *                                        rollbackChangeset
 *
 * Subject-aware: every changeset is scoped to exactly one subject. Cross-subject
 * wikilinks are validated against the target subject's pages but never written
 * to a different subject's vault.
 */

import { randomUUID } from 'crypto';
import {
  getVaultHead,
  commitVaultChanges,
  restoreToHead,
} from '../git/git-service';
import { writeVaultFiles, deleteVaultFile } from './wiki-store';
import { indexTouchedPages } from './indexer';
import { validateFrontmatter } from './frontmatter';
import { parseFrontmatter } from './frontmatter';
import { extractWikiLinks } from './wikilinks';
import { getRawDb } from '../db/client';
import * as pagesRepo from '../db/repos/pages-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { parseWikiPath } from './page-identity';
import { acquireVaultLock } from './vault-mutex';
import type { Changeset, ChangesetEntry, Subject } from '@/lib/contracts';

/**
 * Build an in-memory Changeset object from a list of entries.
 * Does not touch the filesystem or database — use `applyChangeset` for that.
 */
export function createChangeset(
  jobId: string,
  subject: Pick<Subject, 'id' | 'slug'>,
  entries: ChangesetEntry[]
): Changeset {
  return {
    id: randomUUID(),
    jobId,
    subjectId: subject.id,
    subjectSlug: subject.slug,
    entries,
    preHead: '',
    postHead: null,
    status: 'pending',
  };
}

/**
 * Validate a changeset.  Errors block the apply; warnings are surfaced to the
 * caller so they can decide whether to proceed.
 *
 * Cross-subject wikilinks (`[[other-subject:Page]]`) are checked against the
 * referenced subject's page set; missing target subjects yield warnings.
 */
export function validateChangeset(
  changeset: Changeset
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Verify the subject still exists.
  const subject = subjectsRepo.getById(changeset.subjectId);
  if (!subject) {
    errors.push(`Subject ${changeset.subjectId} no longer exists`);
    return { valid: false, errors, warnings };
  }

  // Verify every changeset path belongs to the changeset's subject.
  for (const entry of changeset.entries) {
    if (!entry.path || entry.path.trim() === '') {
      errors.push(`${entry.action} entry has an empty path`);
      continue;
    }

    const parts = parseWikiPath(entry.path);
    if (!parts) {
      errors.push(`[${entry.path}] Path is not a valid wiki path`);
      continue;
    }
    if (parts.subjectSlug !== subject.slug) {
      errors.push(
        `[${entry.path}] Path subject "${parts.subjectSlug}" does not match changeset subject "${subject.slug}"`
      );
    }
  }

  // Per-entry frontmatter + wikilink syntax validation.
  for (const entry of changeset.entries) {
    if (entry.action === 'delete') continue;
    if (entry.content === null || entry.content === undefined) {
      errors.push(`Entry "${entry.path}" has no content for action "${entry.action}"`);
      continue;
    }
    try {
      const parsed = parseFrontmatter(entry.content);
      const result = validateFrontmatter(parsed.data as unknown as Record<string, unknown>);
      if (!result.valid) {
        for (const err of result.errors) {
          errors.push(`[${entry.path}] Frontmatter: ${err}`);
        }
      }
    } catch (err) {
      errors.push(`[${entry.path}] Could not parse frontmatter: ${String(err)}`);
      continue;
    }

    try {
      const { body } = parseFrontmatter(entry.content);
      extractWikiLinks(body, { currentSubjectSlug: subject.slug });
    } catch (err) {
      errors.push(`[${entry.path}] Could not parse wikilinks: ${String(err)}`);
    }
  }

  // Link-target validation: known slugs in the changeset's subject + any creates
  // that this changeset is about to add.
  const knownSlugs = new Set(pagesRepo.getAllPages(subject.id).map((p) => p.slug));
  for (const entry of changeset.entries) {
    if (entry.action !== 'create') continue;
    const parts = parseWikiPath(entry.path);
    if (parts && parts.subjectSlug === subject.slug) {
      knownSlugs.add(parts.slug);
    }
  }

  const titleMap = pagesRepo.getTitleToSlugMap(subject.id);
  const targetSubjectCache = new Map<string, Subject | null>();
  const resolveSubject = (slug: string): Subject | null => {
    if (targetSubjectCache.has(slug)) return targetSubjectCache.get(slug) ?? null;
    const found = subjectsRepo.getBySlug(slug);
    targetSubjectCache.set(slug, found);
    return found;
  };

  for (const entry of changeset.entries) {
    if (entry.action === 'delete' || !entry.content) continue;
    let body: string;
    try {
      ({ body } = parseFrontmatter(entry.content));
    } catch {
      continue;
    }

    const links = extractWikiLinks(body, { currentSubjectSlug: subject.slug });
    for (const link of links) {
      const targetSubjectSlug = link.targetSubjectSlug || subject.slug;

      if (targetSubjectSlug === subject.slug) {
        if (
          !knownSlugs.has(link.target) &&
          !titleMap.has(link.target) &&
          !titleMap.has(link.target.toLowerCase())
        ) {
          warnings.push(`[${entry.path}] Unresolved wikilink: [[${link.raw}]]`);
        }
        continue;
      }

      const targetSubject = resolveSubject(targetSubjectSlug);
      if (!targetSubject) {
        warnings.push(`[${entry.path}] Unknown subject in wikilink: [[${link.raw}]]`);
        continue;
      }
      const exists = pagesRepo.getPageBySlug(targetSubject.id, link.target);
      if (!exists) {
        warnings.push(`[${entry.path}] Unresolved cross-subject wikilink: [[${link.raw}]]`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export interface SourceLinkOps {
  sourceId: string;
  pageSlugs: string[];
  linkPageSource: (subjectId: string, pageSlug: string, sourceId: string) => void;
  updateSourcePageLinks: (sourceId: string, pageSlugs: string[]) => void;
  /** sidecar 更新失败时的告警出口；缺省时静默（不影响 changeset 提交）。 */
  onWarning?: (message: string) => void;
}

export async function applyChangeset(
  changeset: Changeset,
  sourceOps?: SourceLinkOps
): Promise<Changeset> {
  const release = await acquireVaultLock();

  try {
    const db = getRawDb();
    const operationId = changeset.id;
    db
      .prepare(
        `INSERT OR REPLACE INTO operations
         (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
         VALUES (?, ?, ?, '', NULL, ?, 'pending')`
      )
      .run(
        operationId,
        changeset.jobId,
        changeset.subjectId,
        JSON.stringify(changeset.entries)
      );

    const preHead = await getVaultHead();
    const working = { ...changeset, preHead };

    db
      .prepare(`UPDATE operations SET pre_head = ? WHERE id = ?`)
      .run(preHead, operationId);

    try {
      const writeEntries: { path: string; content: string }[] = [];
      const deleteEntries: string[] = [];
      for (const entry of working.entries) {
        if (entry.action === 'create' || entry.action === 'update') {
          if (entry.content !== null && entry.content !== undefined) {
            writeEntries.push({ path: entry.path, content: entry.content });
          }
        } else if (entry.action === 'delete') {
          deleteEntries.push(entry.path);
        }
      }

      writeVaultFiles(writeEntries);
      for (const p of deleteEntries) {
        deleteVaultFile(p);
      }

      const touchedSlugs = collectTouchedSlugs(working.subjectSlug, working.entries);

      const updateIndex = db.transaction(() => {
        indexTouchedPages(working.subjectId, touchedSlugs);

        if (sourceOps) {
          for (const slug of sourceOps.pageSlugs) {
            sourceOps.linkPageSource(working.subjectId, slug, sourceOps.sourceId);
          }
        }
      });
      updateIndex();

      if (sourceOps) {
        try {
          sourceOps.updateSourcePageLinks(sourceOps.sourceId, sourceOps.pageSlugs);
        } catch (err) {
          // sidecar 更新不阻断提交，但必须让调用方可见
          sourceOps.onWarning?.(
            `Failed to update source page links for source ${sourceOps.sourceId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      const affectedPaths = working.entries.map((e) => e.path);
      const postHead = await commitVaultChanges(
        `[subject:${working.subjectSlug}] Apply changeset ${working.id} (job: ${working.jobId})`,
        affectedPaths
      );

      db
        .prepare(
          `UPDATE operations SET post_head = ?, status = 'applied' WHERE id = ?`
        )
        .run(postHead, operationId);

      return { ...working, postHead, status: 'applied' };
    } catch (err) {
      await rollbackChangeset({ ...working, preHead });
      throw err;
    }
  } finally {
    release();
  }
}

/**
 * Revert the vault to the changeset's preHead and reindex slugs in the
 * affected subject. Idempotent — calling it multiple times is safe.
 */
export async function rollbackChangeset(changeset: Changeset): Promise<void> {
  if (!changeset.preHead) return;
  await restoreToHead(changeset.preHead);

  try {
    const sqlite = getRawDb();
    const touchedSlugs = collectTouchedSlugs(changeset.subjectSlug, changeset.entries);
    const reindex = sqlite.transaction(() => {
      indexTouchedPages(changeset.subjectId, touchedSlugs);
    });
    reindex();
  } catch {
    // best effort
  }

  try {
    const sqlite = getRawDb();
    sqlite
      .prepare(`UPDATE operations SET status = ? WHERE id = ?`)
      .run('rolled-back', changeset.id);
  } catch {
    // ignore — operation row may not exist yet
  }
}

function collectTouchedSlugs(subjectSlug: string, entries: ChangesetEntry[]): string[] {
  const slugs = new Set<string>();
  for (const entry of entries) {
    const parts = parseWikiPath(entry.path);
    if (!parts) continue;
    if (parts.subjectSlug !== subjectSlug) continue;
    slugs.add(parts.slug);
  }
  return [...slugs];
}
