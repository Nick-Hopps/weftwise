/**
 * Full database rebuild from the vault on disk.
 *
 * Use this when the SQLite database is missing, corrupt, or out of sync
 * with the vault contents.
 */

import fs from 'fs';
import path from 'path';
import { rebuildPageIndex, rebuildSearchIndex } from './indexer';
import { vaultPath } from '../config/env';
import { getRawDb } from '../db/client';
import * as sourcesRepo from '../db/repos/sources-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { GENERAL_SUBJECT_SLUG } from './page-identity';
import type { Source, SubjectId } from '@/lib/contracts';

export interface RebuildStats {
  pagesIndexed: number;
  linksFound: number;
  sourcesFound: number;
  pageSourceLinksRestored: number;
}

/**
 * Restore source records and page_sources linkages from the JSON sidecars in
 * `vault/.llm-wiki/sources/<subject-slug>/*.json`. Falls back to the legacy
 * flat layout `vault/.llm-wiki/sources/*.json`, attributing sources to the
 * `general` subject.
 */
function restoreSourcesFromSidecars(): {
  sourcesFound: number;
  pageSourceLinksRestored: number;
} {
  let sourcesFound = 0;
  let pageSourceLinksRestored = 0;
  const sourcesRoot = vaultPath('.llm-wiki', 'sources');
  if (!fs.existsSync(sourcesRoot)) {
    return { sourcesFound, pageSourceLinksRestored };
  }

  const generalSubject = subjectsRepo.getBySlug(GENERAL_SUBJECT_SLUG);

  function restoreFile(filePath: string, subjectId: SubjectId): void {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as Source & { linkedPages?: string[] };
      sourcesRepo.upsertSource({
        id: data.id,
        subjectId,
        filename: data.filename,
        contentHash: data.contentHash,
        parsedAt: data.parsedAt ?? null,
        metadataJson: data.metadataJson ?? JSON.stringify(data),
      });
      sourcesFound++;

      if (Array.isArray(data.linkedPages)) {
        for (const pageSlug of data.linkedPages) {
          sourcesRepo.linkPageSource(subjectId, pageSlug, data.id);
          pageSourceLinksRestored++;
        }
      }
    } catch {
      // skip malformed sidecar
    }
  }

  // Subject-scoped subdirectories
  for (const entry of fs.readdirSync(sourcesRoot, { withFileTypes: true })) {
    const fullPath = path.join(sourcesRoot, entry.name);
    if (entry.isDirectory()) {
      const subject = subjectsRepo.getBySlug(entry.name);
      if (!subject) continue;
      const files = fs.readdirSync(fullPath).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        restoreFile(path.join(fullPath, file), subject.id);
      }
    } else if (entry.isFile() && entry.name.endsWith('.json') && generalSubject) {
      // legacy flat layout — attribute to general
      restoreFile(fullPath, generalSubject.id);
    }
  }

  return { sourcesFound, pageSourceLinksRestored };
}

export function rebuildDatabaseFromVault(): RebuildStats {
  const sqlite = getRawDb();

  const wipe = sqlite.transaction(() => {
    sqlite.exec('DELETE FROM page_sources');
    sqlite.exec('DELETE FROM pages_fts');
    sqlite.exec('DELETE FROM wiki_links');
    sqlite.exec('DELETE FROM page_aliases');
    sqlite.exec('DELETE FROM pages');
    sqlite.exec('DELETE FROM sources');
  });
  wipe();

  rebuildPageIndex();
  rebuildSearchIndex();

  const { sourcesFound, pageSourceLinksRestored } = restoreSourcesFromSidecars();

  const pagesIndexed = (
    sqlite.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }
  ).n;
  const linksFound = (
    sqlite.prepare('SELECT COUNT(*) AS n FROM wiki_links').get() as { n: number }
  ).n;

  return { pagesIndexed, linksFound, sourcesFound, pageSourceLinksRestored };
}
