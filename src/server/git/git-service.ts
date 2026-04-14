import simpleGit, { SimpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/env';

/**
 * Returns a simple-git instance pinned to VAULT_PATH only.
 * CRITICAL: baseDir is always the vault path — never the app root.
 */
export function getVaultGit(): SimpleGit {
  const vaultPath = getConfig().vaultPath;
  return simpleGit({ baseDir: vaultPath });
}

/**
 * Ensure the vault directory has an initialized git repository.
 * Sets git user config within the vault repo so commits have an author.
 * Idempotent — safe to call multiple times.
 */
export async function ensureVaultRepo(): Promise<void> {
  const vaultPath = getConfig().vaultPath;

  // Create directory if it doesn't exist
  if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
  }

  const gitDir = path.join(vaultPath, '.git');
  const git = getVaultGit();

  if (!fs.existsSync(gitDir)) {
    await git.init();
  }

  // Set user config in the vault repo (local scope only)
  await git.addConfig('user.name', 'LLM Wiki', false, 'local');
  await git.addConfig('user.email', 'wiki@llm-wiki.local', false, 'local');

  // Ensure at least one commit exists so getVaultHead() never returns '' and
  // rollbackChangeset always has a valid preHead to restore to.
  const log = await git.log({ maxCount: 1 }).catch(() => ({ latest: null }));
  if (!log.latest) {
    const readmePath = path.join(vaultPath, '.llm-wiki', 'README.md');
    if (!fs.existsSync(path.dirname(readmePath))) {
      fs.mkdirSync(path.dirname(readmePath), { recursive: true });
    }
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, '# LLM Wiki Vault\n\nInitialized by agentic-wiki.\n');
    }
    await git.add('.');
    await git.commit('Initial vault commit');
  }
}

/**
 * Returns the current HEAD SHA of the vault repository.
 */
export async function getVaultHead(): Promise<string> {
  const git = getVaultGit();
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash ?? '';
}

/**
 * Stage specified files (or all files if not specified), commit with the given
 * message, and return the resulting commit SHA.
 * If there is nothing to commit, the current HEAD SHA is returned instead.
 */
export async function commitVaultChanges(
  message: string,
  files?: string[],
): Promise<string> {
  const git = getVaultGit();

  // Stage files
  if (files && files.length > 0) {
    await git.add(files);
  } else {
    await git.add('.');
  }

  // Check status — skip commit if working tree is clean
  const status = await git.status();
  if (status.staged.length === 0) {
    return getVaultHead();
  }

  const result = await git.commit(message);
  // result.commit may be empty on some versions; fall back to HEAD
  return result.commit || (await getVaultHead());
}

/**
 * Hard-reset the vault to a specific commit SHA.
 * Used for rollback operations.
 */
export async function restoreToHead(sha: string): Promise<void> {
  const git = getVaultGit();
  await git.reset(['--hard', sha]);
}

/**
 * Return the contents of a file as it existed at a given commit SHA.
 */
export async function getFileAtCommit(
  filePath: string,
  sha: string,
): Promise<string> {
  const git = getVaultGit();
  // git show <sha>:<path>
  const content = await git.show([`${sha}:${filePath}`]);
  return content;
}

/**
 * Return the unified diff between two commit SHAs.
 */
export async function getDiff(fromSha: string, toSha: string): Promise<string> {
  const git = getVaultGit();
  const diff = await git.diff([fromSha, toSha]);
  return diff;
}

/**
 * Returns true when the vault working tree has no uncommitted changes.
 */
export async function isClean(): Promise<boolean> {
  const git = getVaultGit();
  const status = await git.status();
  return status.isClean();
}
