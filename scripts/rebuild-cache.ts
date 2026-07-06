/**
 * CLI script — rebuild the SQLite cache from the vault on disk（灾难恢复用）。
 *
 * Usage:
 *   npm run db:rebuild
 *   npx tsx scripts/rebuild-cache.ts
 *
 * Environment variables:
 *   VAULT_PATH      — path to the wiki vault (default: ./data/vault)
 *   DATABASE_PATH   — path to the SQLite database (default: ./data/wiki.db)
 *
 * 运行前必须停掉 worker 进程：本脚本会先尝试获取 vault 写锁（与 worker/Next.js
 * 写路径共用同一把跨进程文件锁），若锁被占用（worker 仍在跑）会在短暂等待后
 * 报错退出，提示先停掉 worker，而不是悄悄跟运行中的写操作并发损坏数据。
 */

import { rebuildDatabaseFromVault } from '../src/server/wiki/rebuild';
import { acquireVaultLock } from '../src/server/wiki/vault-mutex';

const LOCK_WAIT_TIMEOUT_MS = 5_000;

async function acquireLockOrFail(): Promise<() => void> {
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), LOCK_WAIT_TIMEOUT_MS);
  });
  const result = await Promise.race([acquireVaultLock(), timeout]);
  if (result === 'timeout') {
    console.error('');
    console.error('无法获取 vault 写锁（可能 worker 进程正持有它）。');
    console.error('请先停止 worker（Next.js dev:all / start:all 中的 worker 子进程），再重试 db:rebuild。');
    console.error('');
    process.exit(1);
  }
  return result as () => void;
}

async function main(): Promise<void> {
  const vaultPath = process.env.VAULT_PATH || './data/vault';
  const dbPath = process.env.DATABASE_PATH || './data/wiki.db';

  console.log('');
  console.log('=== LLM Wiki — Rebuild Cache ===');
  console.log(`  Vault:    ${vaultPath}`);
  console.log(`  Database: ${dbPath}`);
  console.log('');
  console.log('获取 vault 写锁...');

  const release = await acquireLockOrFail();
  try {
    console.log('Rebuilding database from vault...');

    const start = Date.now();
    const stats = rebuildDatabaseFromVault();
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);

    console.log('');
    console.log('Done.');
    console.log(`  Pages indexed         : ${stats.pagesIndexed}`);
    console.log(`  Links found           : ${stats.linksFound}`);
    console.log(`  Sources found         : ${stats.sourcesFound}`);
    console.log(`  Page-source links     : ${stats.pageSourceLinksRestored}`);
    console.log(`  Elapsed               : ${elapsed}s`);
    console.log('');
  } finally {
    release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Rebuild failed:', err);
    process.exit(1);
  });
