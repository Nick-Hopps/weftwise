import type { ChangesetEntry } from '@/lib/contracts';

/**
 * 由一次操作的 changeset 条目计算回滚（inverse）条目。
 * - fileAtPreHead(path): 该文件在操作前（preHead）的内容；不存在返回 null
 * - currentExists(path): 该文件当前是否存在（决定 inverse 用 create 还是 update）
 *
 * 判定：
 *   preHead 无该文件        → delete（操作新建了它）
 *   preHead 有 + 当前存在   → update（恢复旧内容）
 *   preHead 有 + 当前不存在 → create（重建旧内容）
 */
export function buildRevertEntries(
  originalEntries: ChangesetEntry[],
  fileAtPreHead: (path: string) => string | null,
  currentExists: (path: string) => boolean,
): ChangesetEntry[] {
  const seen = new Set<string>();
  const result: ChangesetEntry[] = [];
  const reverseMoveBySourcePath = new Map(
    originalEntries
      .filter((entry) => !entry.auxiliary && entry.action === 'create' && entry.movedFromPath)
      .map((entry) => [entry.movedFromPath!, entry.path] as const),
  );
  for (const entry of originalEntries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const prior = fileAtPreHead(entry.path);
    if (prior === null) {
      result.push({
        action: 'delete', path: entry.path, content: null,
        ...(entry.auxiliary ? { auxiliary: true } : {}),
      });
    } else if (currentExists(entry.path)) {
      result.push({
        action: 'update', path: entry.path, content: prior,
        ...(entry.auxiliary ? { auxiliary: true } : {}),
      });
    } else {
      result.push({
        action: 'create', path: entry.path, content: prior,
        ...(entry.auxiliary ? { auxiliary: true } : {}),
        ...(reverseMoveBySourcePath.has(entry.path)
          ? { movedFromPath: reverseMoveBySourcePath.get(entry.path) }
          : {}),
      });
    }
  }
  return result;
}
