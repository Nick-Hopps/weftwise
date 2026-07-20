// SemVer 版本自增规则的唯一真实源，由 .githooks/commit-msg 经 commit-msg-bump.ts 调用。
// 设计稿：docs/specs/2026-07-20-semver-version-automation.md

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SUBJECT_RE = /^(feat|fix)(\([^)]*\))?(!)?:\s/;

/**
 * 根据提交信息计算下一个版本号。
 *
 * - beta 阶段（major = 0）：feat（含破坏性变更）→ minor +1；fix → patch +1
 * - 稳定阶段（major ≥ 1）：破坏性变更 → major +1；feat → minor +1；fix → patch +1
 * - 其他提交类型、无法解析的版本号（含预发布后缀）→ null（不自增）
 */
export function computeNextVersion(currentVersion: string, commitMessage: string): string | null {
  const versionMatch = VERSION_RE.exec(currentVersion);
  if (!versionMatch) return null;

  const subject = commitMessage.split('\n', 1)[0];
  const subjectMatch = SUBJECT_RE.exec(subject);
  if (!subjectMatch) return null;

  const [major, minor, patch] = versionMatch.slice(1).map(Number);
  const type = subjectMatch[1];
  const breaking = subjectMatch[3] === '!' || /^BREAKING CHANGE:/m.test(commitMessage);

  if (major >= 1 && breaking) return `${major + 1}.0.0`;
  if (type === 'feat' || breaking) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
