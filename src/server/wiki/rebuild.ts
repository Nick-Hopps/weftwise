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
import type { Source } from '@/lib/contracts';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RebuildStats {
  pagesIndexed: number;
  linksFound: number;
  sourcesFound: number;
  pageSourceLinksRestored: number;
}

/**
 * Wipe and rebuild the entire SQLite index from the vault on disk.
 *
 * Steps:
 * 1. Truncate pages, page_aliases, wiki_links, pages_fts, page_sources.
 * 2. Rebuild the page index (pages + wiki_links) via `rebuildPageIndex`.
 * 3. Rebuild the FTS5 search index via `rebuildSearchIndex`.
 * 4. Scan `.llm-wiki/sources/*.json` and restore the sources table.
 * 5. Restore page_sources linkages from sidecar `linkedPages` field.
 * 6. Return aggregate statistics.
 */
export function rebuildDatabaseFromVault(): RebuildStats {
  const sqlite = getRawDb();

  // Step 1 — wipe dependent tables first to satisfy foreign-key constraints
  const wipe = sqlite.transaction(() => {
    sqlite.exec('DELETE FROM page_sources');
    sqlite.exec('DELETE FROM pages_fts');
    sqlite.exec('DELETE FROM wiki_links');
    sqlite.exec('DELETE FROM page_aliases');
    sqlite.exec('DELETE FROM pages');
    sqlite.exec('DELETE FROM sources');
  });
  wipe();

  // Step 2 — rebuild pages + wiki_links
  rebuildPageIndex();

  // Step 3 — rebuild FTS5
  rebuildSearchIndex();

  // Step 4 + 5 — restore sources and page_sources from JSON sidecar files
  let sourcesFound = 0;
  let pageSourceLinksRestored = 0;
  const sourcesDir = vaultPath('.llm-wiki', 'sources');
  if (fs.existsSync(sourcesDir)) {
    const files = fs
      .readdirSync(sourcesDir)
      .filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(sourcesDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as Source & { linkedPages?: string[] };
        sourcesRepo.upsertSource({
          id: data.id,
          filename: data.filename,
          contentHash: data.contentHash,
          parsedAt: data.parsedAt ?? null,
          metadataJson: data.metadataJson ?? JSON.stringify(data),
        });
        sourcesFound++;

        // Restore page_sources linkages from sidecar
        if (Array.isArray(data.linkedPages)) {
          for (const pageSlug of data.linkedPages) {
            sourcesRepo.linkPageSource(pageSlug, data.id);
            pageSourceLinksRestored++;
          }
        }
      } catch {
        // Skip malformed source JSON files
      }
    }
  }

  // Step 6 — gather statistics
  const pagesIndexed = (
    sqlite.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }
  ).n;

  const linksFound = (
    sqlite.prepare('SELECT COUNT(*) AS n FROM wiki_links').get() as { n: number }
  ).n;

  return { pagesIndexed, linksFound, sourcesFound, pageSourceLinksRestored };
}
