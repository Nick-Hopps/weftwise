import { getRawDb } from '../client';

export interface OperationRow {
  id: string;
  jobId: string;
  subjectId: string;
  preHead: string;
  postHead: string | null;
  changesetJson: string;
  status: string;
  jobType: string | null; // LEFT JOIN jobs.type；同步编辑/删除无 jobs 行 → null
}

interface RawRow {
  id: string;
  job_id: string;
  subject_id: string;
  pre_head: string;
  post_head: string | null;
  changeset_json: string;
  status: string;
  job_type: string | null;
}

const SELECT_COLS = `o.id, o.job_id, o.subject_id, o.pre_head, o.post_head, o.changeset_json, o.status, j.type AS job_type`;

function mapRow(r: RawRow): OperationRow {
  return {
    id: r.id,
    jobId: r.job_id,
    subjectId: r.subject_id,
    preHead: r.pre_head,
    postHead: r.post_head,
    changesetJson: r.changeset_json,
    status: r.status,
    jobType: r.job_type ?? null,
  };
}

/** 时间线：本 subject、已提交（post_head 非空）、applied/reverted，按 rowid 倒序（=时间倒序）。 */
export function listForSubject(subjectId: string): OperationRow[] {
  const rows = getRawDb()
    .prepare(
      `SELECT ${SELECT_COLS}
       FROM operations o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.subject_id = ? AND o.post_head IS NOT NULL
             AND o.status IN ('applied','reverted')
       ORDER BY o.rowid DESC`,
    )
    .all(subjectId) as RawRow[];
  return rows.map(mapRow);
}

/** Fix / Curate 写后校验：按提交顺序返回当前 Job 在本 Subject 已应用的 operation。 */
export function listAppliedForJob(jobId: string, subjectId: string): OperationRow[] {
  const rows = getRawDb()
    .prepare(
      `SELECT ${SELECT_COLS}
       FROM operations o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.job_id = ? AND o.subject_id = ?
             AND o.status = 'applied' AND o.post_head IS NOT NULL
       ORDER BY o.rowid ASC`,
    )
    .all(jobId, subjectId) as RawRow[];
  return rows.map(mapRow);
}

/** 单行（回滚 / diff 用）；不限 subject，由调用方做 subject 守卫。 */
export function getById(id: string): OperationRow | null {
  const r = getRawDb()
    .prepare(
      `SELECT ${SELECT_COLS}
       FROM operations o LEFT JOIN jobs j ON j.id = o.job_id
       WHERE o.id = ?`,
    )
    .get(id) as RawRow | undefined;
  return r ? mapRow(r) : null;
}

/** 用户回滚一次已提交操作后标记原操作；与 Saga 失败的 'rolled-back' 语义区分。 */
export function markReverted(id: string): void {
  getRawDb().prepare(`UPDATE operations SET status = 'reverted' WHERE id = ?`).run(id);
}

/** History PendingAction 最终化：只允许把本 Subject 内仍 applied 的原操作标为 reverted。 */
export function markRevertedIfApplied(id: string, subjectId: string): boolean {
  const result = getRawDb().prepare(`
    UPDATE operations SET status = 'reverted'
    WHERE id = ? AND subject_id = ? AND status = 'applied'
  `).run(id, subjectId);
  return result.changes === 1;
}

/**
 * operations 表 GC：每 subject 只保留最近 `keepPerSubject` 条**终态**（非 pending）行。
 *
 * 注意：`operations` 表没有可靠的时间戳列（无 `created_at`），因此无法实现需求文档
 * 描述的"500 条或 90 天，取更宽者"双条件保留策略——这里退化为单条件（仅按数量，
 * 按 subject 隔离，rowid 倒序=时间倒序）。`pending` 行永不删除（崩溃恢复依赖它）。
 * 被删除的 operation 对应的 `/history` 时间线条目会随之消失（vault git 提交仍在，
 * 数据本身不受影响，只是无法再从 UI 上追溯/一键回滚该次操作）。
 */
export function pruneOldOperations(keepPerSubject = 500): number {
  const result = getRawDb()
    .prepare(
      `DELETE FROM operations
       WHERE status != 'pending'
         AND id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY subject_id ORDER BY rowid DESC
             ) AS rn
             FROM operations
             WHERE status != 'pending'
           )
           WHERE rn > ?
         )`,
    )
    .run(keepPerSubject);
  return result.changes;
}
