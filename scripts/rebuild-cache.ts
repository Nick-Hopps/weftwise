/**
 * CLI script — rebuild the SQLite cache from the vault on disk.
 *
 * Usage:
 *   npx tsx scripts/rebuild-cache.ts
 *
 * Environment variables:
 *   VAULT_PATH      — path to the wiki vault (default: ./data/vault)
 *   DATABASE_PATH   — path to the SQLite database (default: ./data/wiki.db)
 */

import { rebuildDatabaseFromVault } from '../src/server/wiki/rebuild';

async function main(): Promise<void> {
  const vaultPath = process.env.VAULT_PATH || './data/vault';
  const dbPath = process.env.DATABASE_PATH || './data/wiki.db';

  console.log('');
  console.log('=== LLM Wiki — Rebuild Cache ===');
  console.log(`  Vault:    ${vaultPath}`);
  console.log(`  Database: ${dbPath}`);
  console.log('');
  console.log('Rebuilding database from vault...');

  const start = Date.now();
  const stats = rebuildDatabaseFromVault();
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);

  console.log('');
  console.log('Done.');
  console.log(`  Pages indexed : ${stats.pagesIndexed}`);
  console.log(`  Links found   : ${stats.linksFound}`);
  console.log(`  Sources found : ${stats.sourcesFound}`);
  console.log(`  Elapsed       : ${elapsed}s`);
  console.log('');
}

main().catch((err) => {
  console.error('Rebuild failed:', err);
  process.exit(1);
});
