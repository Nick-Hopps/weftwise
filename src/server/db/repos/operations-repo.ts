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
