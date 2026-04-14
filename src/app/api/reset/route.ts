import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '@/server/middleware/auth';
import { getRawDb } from '@/server/db/client';
import { vaultPath } from '@/server/config/env';
import { commitVaultChanges } from '@/server/git/git-service';
import { rebuildPageIndex } from '@/server/wiki/indexer';

export const runtime = 'nodejs';

/**
 * POST /api/reset
 *
 * Clears all ingested data: wiki pages, raw sources, source metadata,
 * jobs, and database tables. Resets the vault to a clean state with
 * only index.md and log.md stubs.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const now = new Date().toISOString();
  const sqlite = getRawDb();

  // Step 1: Truncate all data tables
  const wipe = sqlite.transaction(() => {
    sqlite.exec('DELETE FROM page_sources');
    sqlite.exec('DELETE FROM pages_fts');
    sqlite.exec('DELETE FROM wiki_links');
    sqlite.exec('DELETE FROM page_aliases');
    sqlite.exec('DELETE FROM pages');
    sqlite.exec('DELETE FROM sources');
    sqlite.exec('DELETE FROM job_events');
    sqlite.exec('DELETE FROM operations');
    sqlite.exec('DELETE FROM jobs');
  });
  wipe();

  // Step 2: Delete wiki pages (except index.md and log.md which we'll reset)
  const wikiDir = vaultPath('wiki');
  if (fs.existsSync(wikiDir)) {
    for (const file of fs.readdirSync(wikiDir)) {
      if (file.endsWith('.md')) {
        fs.unlinkSync(path.join(wikiDir, file));
      }
    }
  }

  // Step 3: Delete raw sources
  const rawDir = vaultPath('raw');
  if (fs.existsSync(rawDir)) {
    for (const file of fs.readdirSync(rawDir)) {
      fs.unlinkSync(path.join(rawDir, file));
    }
  }

  // Step 4: Delete source metadata sidecars
  const sourcesDir = vaultPath('.llm-wiki', 'sources');
  if (fs.existsSync(sourcesDir)) {
    for (const file of fs.readdirSync(sourcesDir)) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(sourcesDir, file));
      }
    }
  }

  // Step 5: Re-create minimal index.md and log.md stubs
  fs.mkdirSync(wikiDir, { recursive: true });

  fs.writeFileSync(
    path.join(wikiDir, 'index.md'),
    `---\ntitle: Index\ncreated: ${now}\nupdated: ${now}\ntags: [meta]\nsources: []\n---\n\n# Wiki Index\n\nWelcome to your LLM Wiki. Start by ingesting a source document.\n`,
  );

  fs.writeFileSync(
    path.join(wikiDir, 'log.md'),
    `---\ntitle: Change Log\ncreated: ${now}\nupdated: ${now}\ntags: [meta]\nsources: []\n---\n\n# Change Log\n\nAll wiki changes are recorded here.\n`,
  );

  // Step 6: Commit the reset to vault git
  try {
    await commitVaultChanges('Reset wiki: cleared all ingested data');
  } catch {
    // Git commit failure is non-fatal
  }

  // Step 8: Rebuild pages + wiki_links + FTS from the two stub pages
  rebuildPageIndex();

  return NextResponse.json({
    message: 'All ingested data has been cleared',
    timestamp: now,
  });
}
