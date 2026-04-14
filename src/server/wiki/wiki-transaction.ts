/**
 * Transactional wiki changeset execution using the Saga pattern.
 *
 * Flow:
 *   createChangeset → validateChangeset → applyChangeset
 *                                             ↓ (on error)
 *                                        rollbackChangeset
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
import { slugFromWikiPath } from './page-identity';
import { acquireVaultLock } from './vault-mutex';
import type { Changeset, ChangesetEntry } from '@/lib/contracts';

// ---------------------------------------------------------------------------
// createChangeset
// ---------------------------------------------------------------------------

/**
 * Build an in-memory Changeset object from a list of entries.
 * Does not touch the filesystem or database — use `applyChangeset` for that.
 */
export function createChangeset(
  jobId: string,
  entries: ChangesetEntry[]
): Changeset {
  return {
    id: randomUUID(),
    jobId,
    entries,
    preHead: '',
    postHead: null,
    status: 'pending',
  };
}

// ---------------------------------------------------------------------------
// validateChangeset
// ---------------------------------------------------------------------------

/**
 * Validate all entries in a changeset:
 * - `create` / `update` entries must have valid frontmatter.
 * - All wikilinks in the body must be parseable.
 * - `delete` entries need only a non-empty path.
 *
 * Returns `{ valid, errors }` without throwing.
 */
export function validateChangeset(
  changeset: Changeset
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];

  for (const entry of changeset.entries) {
    if (entry.action === 'delete') {
      if (!entry.path || entry.path.trim() === '') {
        errors.push(`Delete entry has an empty path`);
      }
      continue;
    }

    // create / update
    if (entry.content === null || entry.content === undefined) {
      errors.push(`Entry "${entry.path}" has no content for action "${entry.action}"`);
      continue;
    }

    // Validate frontmatter
    let body = entry.content;
    try {
      const parsed = parseFrontmatter(entry.content);
      const result = validateFrontmatter(
        parsed.data as unknown as Record<string, unknown>
      );
      if (!result.valid) {
        for (const err of result.errors) {
          errors.push(`[${entry.path}] Frontmatter: ${err}`);
        }
      }
      body = parsed.body;
    } catch (err) {
      errors.push(
        `[${entry.path}] Could not parse frontmatter: ${String(err)}`
      );
      continue;
    }

    // Validate wikilinks (extraction should not throw, but guard anyway)
    try {
      extractWikiLinks(body);
    } catch (err) {
      errors.push(`[${entry.path}] Could not parse wikilinks: ${String(err)}`);
    }
  }

  // Link target validation: check wikilinks resolve to known pages
  const knownSlugs = new Set(pagesRepo.getAllPages().map((p) => p.slug));
  // Include pending creates from this changeset
  for (const entry of changeset.entries) {
    if (entry.action === 'create') {
      knownSlugs.add(slugFromWikiPath(entry.path));
    }
  }
  // Include aliases
  const titleMap = pagesRepo.getTitleToSlugMap();

  const warnings: string[] = [];
  for (const entry of changeset.entries) {
    if (entry.action === 'delete' || !entry.content) continue;
    try {
      const { body } = parseFrontmatter(entry.content);
      const links = extractWikiLinks(body);
      for (const link of links) {
        const target = link.target;
        if (!knownSlugs.has(target) && !titleMap.has(target) && !titleMap.has(target.toLowerCase())) {
          warnings.push(`[${entry.path}] Unresolved wikilink: [[${link.raw}]]`);
        }
      }
    } catch {
      // Already caught in frontmatter validation above
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// applyChangeset
// ---------------------------------------------------------------------------

/**
 * Execute a changeset as an atomic saga:
 *
 * 1. Snapshot the current git HEAD (preHead).
 * 2. Write / delete vault files on disk.
 * 3. Update the SQLite index inside a single transaction.
 * 4. Commit the vault changes to git.
 * 5. Record the operation in the `operations` table.
 * 6. Return the updated changeset with `status = 'applied'` and `postHead`.
 *
 * On any failure the saga calls `rollbackChangeset` and re-throws.
 */
export interface SourceLinkOps {
  sourceId: string;
  pageSlugs: string[];
  linkPageSource: (pageSlug: string, sourceId: string) => void;
  updateSourcePageLinks: (sourceId: string, pageSlugs: string[]) => void;
}

export async function applyChangeset(
  changeset: Changeset,
  sourceOps?: SourceLinkOps,
): Promise<Changeset> {
  // Acquire mutex to prevent concurrent vault writes
  const release = await acquireVaultLock();

  try {
    // Step 0 — record pending operation before any writes
    const db = getRawDb();
    const operationId = changeset.id;
    db
      .prepare(
        `INSERT OR REPLACE INTO operations (id, job_id, pre_head, post_head, changeset_json, status) VALUES (?, ?, '', NULL, ?, 'pending')`
      )
      .run(operationId, changeset.jobId, JSON.stringify(changeset.entries));

    // Step 1 — snapshot current HEAD
    const preHead = await getVaultHead();
    const working = { ...changeset, preHead };

    // Update operation with actual preHead
    db
      .prepare(`UPDATE operations SET pre_head = ? WHERE id = ?`)
      .run(preHead, operationId);

    try {
      // Step 2 — write / delete vault files
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

      // Step 3 — collect affected slugs and update SQLite in a transaction
      const touchedSlugs = [
        ...new Set(
          working.entries.map((e) => slugFromWikiPath(e.path))
        ),
      ];

      const updateIndex = db.transaction(() => {
        indexTouchedPages(touchedSlugs);

        // Include source linkage inside the same transaction (Gap-4 fix)
        if (sourceOps) {
          for (const slug of sourceOps.pageSlugs) {
            sourceOps.linkPageSource(slug, sourceOps.sourceId);
          }
        }
      });
      updateIndex();

      // Update sidecar metadata (outside SQLite tx, but after git commit captures it)
      if (sourceOps) {
        try {
          sourceOps.updateSourcePageLinks(sourceOps.sourceId, sourceOps.pageSlugs);
        } catch {
          // Best-effort: sidecar update is recoverable via rebuild
        }
      }

      // Step 4 — git commit
      const affectedPaths = working.entries.map((e) => e.path);
      const postHead = await commitVaultChanges(
        `Apply changeset ${working.id} (job: ${working.jobId})`,
        affectedPaths
      );

      // Step 5 — update operation record to 'applied'
      db
        .prepare(
          `UPDATE operations SET post_head = ?, status = 'applied' WHERE id = ?`
        )
        .run(postHead, operationId);

      // Step 6 — return updated changeset
      return {
        ...working,
        postHead,
        status: 'applied',
      };
    } catch (err) {
      await rollbackChangeset({ ...working, preHead });
      throw err;
    }
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// rollbackChangeset
// ---------------------------------------------------------------------------

/**
 * Revert the vault to the git commit recorded in `changeset.preHead`,
 * and roll back any SQLite index changes made by the changeset (H2 fix).
 */
export async function rollbackChangeset(changeset: Changeset): Promise<void> {
  if (!changeset.preHead) return;
  await restoreToHead(changeset.preHead);

  // Roll back SQLite index: re-index affected slugs from the restored filesystem state
  try {
    const sqlite = getRawDb();
    const touchedSlugs = [
      ...new Set(changeset.entries.map((e) => slugFromWikiPath(e.path))),
    ];
    const reindex = sqlite.transaction(() => {
      indexTouchedPages(touchedSlugs);
    });
    reindex();
  } catch {
    // Best-effort: if re-indexing fails, at least git is restored
  }

  // Mark operation as rolled back if it was already persisted
  try {
    const sqlite = getRawDb();
    sqlite
      .prepare(`UPDATE operations SET status = ? WHERE id = ?`)
      .run('rolled-back', changeset.id);
  } catch {
    // Ignore — the row may not exist yet
  }
}
