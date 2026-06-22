import { parseWikiPath } from './page-identity';
import type { ChangesetEntry, HistoryEntry } from '@/lib/contracts';
import type { OperationRow } from '../db/repos/operations-repo';
import type { VaultCommit } from '../git/git-service';

function inferType(jobType: string | null, entries: ChangesetEntry[]): string {
  if (jobType) return jobType;
  const allDelete = entries.length > 0 && entries.every((e) => e.action === 'delete');
  return allDelete ? 'delete' : 'edit';
}

/**
 * 把 operations 行 + git 提交元数据合成为前端 HistoryEntry。
 * - 受影响页 / 类型推断：来自 changeset_json（无 jobType 时按动作推断 edit/delete）
 * - 时间 / message：按 postHead 从 commitBySha 取，缺失则 null/''
 */
export function buildHistoryEntries(
  rows: OperationRow[],
  commitBySha: Map<string, VaultCommit>,
): HistoryEntry[] {
  return rows.map((row) => {
    let entries: ChangesetEntry[] = [];
    try {
      const parsed = JSON.parse(row.changesetJson);
      if (Array.isArray(parsed)) entries = parsed as ChangesetEntry[];
    } catch {
      entries = [];
    }
    const commit = row.postHead ? commitBySha.get(row.postHead) : undefined;
    return {
      id: row.id,
      sha: row.postHead,
      date: commit?.date ?? null,
      type: inferType(row.jobType, entries),
      message: commit?.message ?? '',
      affectedPages: entries.map((e) => ({
        slug: parseWikiPath(e.path)?.slug ?? e.path,
        action: e.action,
      })),
      status: row.status === 'reverted' ? 'reverted' : 'applied',
    };
  });
}
