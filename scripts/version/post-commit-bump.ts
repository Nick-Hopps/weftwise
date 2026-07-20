// post-commit hook 入口：根据刚完成提交的类型自增 package.json 版本号，
// 并用 `git commit --amend --no-verify` 把版本变更并回同一提交。
// 之所以不用 commit-msg hook：git 在该阶段前已锁定提交树，hook 内 `git add` 的内容不会进入本次提交（实测验证）。
// 守卫顺序与已知限制见 docs/specs/2026-07-20-semver-version-automation.md 第五节。
// 任何意外错误只打印警告不阻断——版本号自动化不应影响提交流程。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeNextVersion } from './compute-next-version';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', env: process.env }).trim();
}

function versionOf(gitRef: string): string | null {
  try {
    return (JSON.parse(git('show', `${gitRef}:package.json`)) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function indexOrPackageJsonDirty(): boolean {
  try {
    // index 与 HEAD 不一致（partial commit 的遗留暂存）或 package.json 有未暂存改动时，
    // amend 会卷入不属于本提交的内容，跳过自增
    git('diff', '--cached', '--quiet');
    git('diff', '--quiet', '--', 'package.json');
    return false;
  } catch {
    return true;
  }
}

function main(): void {
  // 逃生舱；同时防止自我 amend 的 post-commit 递归（amend 时显式带上该变量）
  if (process.env.SKIP_VERSION_BUMP === '1') return;

  // merge / rebase / cherry-pick 进行中不自增（--git-dir 对 worktree 返回各自的私有目录）
  const gitDir = git('rev-parse', '--git-dir');
  const inProgress = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'];
  if (inProgress.some((marker) => existsSync(path.join(gitDir, marker)))) return;

  // HEAD 与父提交版本已不同 = 本提交已带版本变更（覆盖 amend 重触发、reset --soft 压缩重建）
  const headVersion = versionOf('HEAD');
  const parentVersion = versionOf('HEAD^');
  if (headVersion === null) return;
  if (parentVersion !== null && parentVersion !== headVersion) return;

  const nextVersion = computeNextVersion(headVersion, git('log', '-1', '--format=%B'));
  if (nextVersion === null) return;

  if (indexOrPackageJsonDirty()) {
    process.stderr.write('version bump 跳过：暂存区或 package.json 有未提交改动，请手动处理后重试\n');
    return;
  }

  const packageJsonPath = path.join(git('rev-parse', '--show-toplevel'), 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
  pkg.version = nextVersion;
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  git('add', packageJsonPath);
  execFileSync('git', ['commit', '--amend', '--no-edit', '--no-verify', '--quiet'], {
    encoding: 'utf8',
    env: { ...process.env, SKIP_VERSION_BUMP: '1' },
  });
  process.stderr.write(`version: ${headVersion} → ${nextVersion}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`version bump 跳过（发生错误，不影响提交）：${String(error)}\n`);
}
