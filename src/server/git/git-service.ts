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
 * 在 `sinceSha..HEAD` 提交范围内查找 commit message 含给定标记的提交，
 * 返回其 SHA；找不到返回 null。`sinceSha` 为空/未提供时检索全部 log。
 *
 * 供崩溃恢复用：并发调度下本 changeset 的提交可能已不是 HEAD（崩溃后
 * 其他任务又正常提交过），标记必须在 preHead 之后的整个范围内查找。
 */
export async function findCommitWithMarker(
  marker: string,
  sinceSha?: string
): Promise<string | null> {
  const git = getVaultGit();
  try {
    const range = sinceSha ? [`${sinceSha}..HEAD`] : [];
    const raw = await git.raw(['log', ...range, '--pretty=format:%H%x1f%s']);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const idx = line.indexOf('\x1f');
      if (idx < 0) continue;
      const sha = line.slice(0, idx);
      const subject = line.slice(idx + 1);
      if (subject.includes(marker)) return sha;
    }
    return null;
  } catch {
    // 空仓库（无 HEAD）或非法 range → 视为未找到
    return null;
  }
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
 * Remove untracked files limited to the given vault-relative paths.
 * Needed by rollback: `reset --hard` does not delete untracked files, and
 * create-entry pages are exactly untracked before their first commit.
 */
export async function cleanUntrackedPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const git = getVaultGit();
  await git.clean('f', ['--', ...paths]);
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

export interface VaultCommit {
  sha: string;
  date: string;
  message: string;
}

/**
 * 解析 `git log --pretty=format:%H%x1f%cI%x1f%s` 的原始输出。
 * 每行一个提交，字段用单元分隔符 \x1f 分隔（正文不会出现该字符）。
 */
export function parseGitLog(raw: string): VaultCommit[] {
  if (!raw) return [];
  const commits: VaultCommit[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\x1f');
    const sha = parts[0];
    if (!sha) continue;
    commits.push({
      sha,
      date: parts[1] ?? '',
      message: parts.slice(2).join('\x1f'),
    });
  }
  return commits;
}

/**
 * 取 vault git 提交日志（最新在前，默认上限 2000 条）。
 * 仅用于给时间线补充显示时间戳/commit message；列表完整性由 operations 表保证。
 */
export async function getVaultLog(limit = 2000): Promise<VaultCommit[]> {
  const git = getVaultGit();
  try {
    const raw = await git.raw([
      'log',
      '-n',
      String(limit),
      '--pretty=format:%H%x1f%cI%x1f%s',
    ]);
    return parseGitLog(raw);
  } catch {
    return [];
  }
}
