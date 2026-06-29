import { eq, and, asc } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
import { jobs, jobEvents } from '../schema';
import type { Job, JobEvent, SubjectId } from '@/lib/contracts';

export function enqueueJob(
  type: Job['type'],
  params: Record<string, unknown> = {},
  subjectId: SubjectId | null = null
): Job {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const job: Job = {
    id,
    type,
    status: 'pending',
    subjectId,
    paramsJson: JSON.stringify(params),
    resultJson: null,
    createdAt,
    startedAt: null,
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
  };

  db
    .insert(jobs)
    .values({
      id: job.id,
      type: job.type,
      status: job.status,
      subjectId: job.subjectId,
      paramsJson: job.paramsJson,
      resultJson: job.resultJson,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      leaseExpiresAt: job.leaseExpiresAt,
      heartbeatAt: job.heartbeatAt,
      attemptCount: job.attemptCount,
    })
    .run();

  return job;
}

const LEASE_DURATION_MS = 2 * 60 * 1000; // 2 minutes

export function claimNextJob(type?: Job['type']): Job | null {
  const sqlite = getRawDb();
  const now = new Date();
  const startedAt = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

  const stmt = type
    ? sqlite.prepare(`
        UPDATE jobs SET status = 'running', started_at = ?, heartbeat_at = ?,
          lease_expires_at = ?, attempt_count = COALESCE(attempt_count, 0) + 1,
          cancel_requested = 0
        WHERE id = (
          SELECT id FROM jobs
          WHERE (status = 'pending' AND type = ?)
             OR (status = 'running' AND type = ? AND lease_expires_at < ?)
          ORDER BY created_at ASC LIMIT 1
        )
        RETURNING *
      `)
    : sqlite.prepare(`
        UPDATE jobs SET status = 'running', started_at = ?, heartbeat_at = ?,
          lease_expires_at = ?, attempt_count = COALESCE(attempt_count, 0) + 1,
          cancel_requested = 0
        WHERE id = (
          SELECT id FROM jobs
          WHERE status = 'pending'
             OR (status = 'running' AND lease_expires_at < ?)
          ORDER BY created_at ASC LIMIT 1
        )
        RETURNING *
      `);

  const row = (type
    ? stmt.get(startedAt, startedAt, leaseExpiresAt, type, type, startedAt)
    : stmt.get(startedAt, startedAt, leaseExpiresAt, startedAt)
  ) as JobRow | undefined;

  if (!row) return null;
  return rowToJobFromRaw(row);
}

export function requeueJob(jobId: string): void {
  const sqlite = getRawDb();
  sqlite.prepare(`
    UPDATE jobs SET status = 'pending', lease_expires_at = NULL, heartbeat_at = NULL,
      cancel_requested = 0
    WHERE id = ?
  `).run(jobId);
}

export type CancelResult = 'cancelled' | 'already-terminal' | 'not-found';

/**
 * 取消 / 终结任务（用户主动终止）。原子事务内：
 *  - 不存在 → 'not-found'；已 completed → 'already-terminal'（成功结果不动）；
 *  - 已 failed → **终结**：保留原 result_json.error + 标 cancelled=true + 置 cancel_requested=1
 *    + 删该 job 全部 ingest 检查点（status 仍 failed，但检查点已清 → 不再可 resume；
 *    配合 retry 路由对 cancelled 的拦截，彻底放弃这次报错的摄取）；
 *  - pending / running → 落终态 failed + 置 cancel_requested=1 + 清租约/心跳
 *    + 写 cancelled 标记结果 + 删检查点（防断点续传"死而复生"）。
 * 终态复用 'failed'（避免新增 status 字面量引发 SSE/前端终态判定的静默遗漏），
 * 由 result_json.cancelled / job:cancelled 事件区分"取消"与"失败"。
 * running 任务的在途 LLM 调用由 worker 侧 ctx.cancelled() 轮询 cancel_requested 后中止。
 */
export function requestCancel(jobId: string): CancelResult {
  const sqlite = getRawDb();
  const tx = sqlite.transaction((): CancelResult => {
    const row = sqlite
      .prepare(`SELECT status, result_json FROM jobs WHERE id = ?`)
      .get(jobId) as { status: string; result_json: string | null } | undefined;
    if (!row) return 'not-found';
    if (row.status === 'completed') return 'already-terminal';

    if (row.status === 'failed') {
      // 终结一个已失败/报错的 ingest：清检查点使其不再可 resume，标 cancelled（保留原错误供查阅）。
      let merged: Record<string, unknown> = { cancelled: true };
      try {
        const prev = row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : {};
        merged = { ...prev, cancelled: true };
      } catch {
        // 原结果不可解析时仅写 cancelled 标记
      }
      sqlite
        .prepare(`UPDATE jobs SET cancel_requested = 1, result_json = ? WHERE id = ?`)
        .run(JSON.stringify(merged), jobId);
      sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id = ?`).run(jobId);
      return 'cancelled';
    }

    const resultJson = JSON.stringify({
      error: { message: 'Cancelled by user' },
      cancelled: true,
    });
    sqlite
      .prepare(`
        UPDATE jobs SET status = 'failed', cancel_requested = 1,
          lease_expires_at = NULL, heartbeat_at = NULL,
          completed_at = ?, result_json = ?
        WHERE id = ?
      `)
      .run(new Date().toISOString(), resultJson, jobId);
    sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id = ?`).run(jobId);
    return 'cancelled';
  });
  return tx();
}

/** worker 侧轮询：该 job 是否被请求取消（ctx.cancelled() 的真实来源）。 */
export function isCancelRequested(jobId: string): boolean {
  const sqlite = getRawDb();
  const row = sqlite
    .prepare(`SELECT cancel_requested FROM jobs WHERE id = ?`)
    .get(jobId) as { cancel_requested: number | null } | undefined;
  return !!row && row.cancel_requested === 1;
}

export function reclaimExpiredJobs(): number {
  const sqlite = getRawDb();
  const now = new Date().toISOString();
  const result = sqlite.prepare(`
    UPDATE jobs SET status = 'pending', lease_expires_at = NULL, heartbeat_at = NULL
    WHERE status = 'running' AND lease_expires_at < ?
  `).run(now);
  return result.changes;
}

export function updateHeartbeat(jobId: string): void {
  const sqlite = getRawDb();
  const now = new Date();
  const heartbeatAt = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();
  sqlite.prepare(`
    UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ?
  `).run(heartbeatAt, leaseExpiresAt, jobId);
}

export function getJob(id: string): Job | null {
  const db = getDb();
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  return row ? rowToJob(row) : null;
}

export interface JobFilter {
  status?: Job['status'];
  type?: Job['type'];
  subjectId?: SubjectId;
}

export function listJobs(filter?: JobFilter): Job[] {
  const db = getDb();
  let query = db.select().from(jobs).$dynamic();

  const clauses = [];
  if (filter?.status) clauses.push(eq(jobs.status, filter.status));
  if (filter?.type) clauses.push(eq(jobs.type, filter.type));
  if (filter?.subjectId) clauses.push(eq(jobs.subjectId, filter.subjectId));

  if (clauses.length === 1) {
    query = query.where(clauses[0]);
  } else if (clauses.length > 1) {
    query = query.where(and(...clauses));
  }

  const rows = query.orderBy(asc(jobs.createdAt)).all();
  return rows.map(rowToJob);
}

export function completeJob(
  id: string,
  result: Record<string, unknown>
): void {
  const db = getDb();
  db
    .update(jobs)
    .set({
      status: 'completed',
      resultJson: JSON.stringify(result),
      completedAt: new Date().toISOString(),
    })
    .where(eq(jobs.id, id))
    .run();
}

export function failJob(id: string, error: unknown): void {
  const db = getDb();
  const errorObj: Record<string, unknown> =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };

  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (e.usage) errorObj.usage = e.usage;
    if (e.finishReason) errorObj.finishReason = e.finishReason;
    if (e.text) errorObj.responseText = String(e.text).slice(0, 2000);
    if (e.cause) {
      errorObj.cause = e.cause instanceof Error
        ? e.cause.message
        : String(e.cause);
    }
  }

  db
    .update(jobs)
    .set({
      status: 'failed',
      resultJson: JSON.stringify({ error: errorObj }),
      completedAt: new Date().toISOString(),
    })
    .where(eq(jobs.id, id))
    .run();
}

export function appendJobEvent(
  jobId: string,
  type: string,
  message: string,
  data?: Record<string, unknown>
): JobEvent {
  const db = getDb();
  const event: JobEvent = {
    id: crypto.randomUUID(),
    jobId,
    type,
    message,
    dataJson: data !== undefined ? JSON.stringify(data) : null,
    createdAt: new Date().toISOString(),
  };

  db
    .insert(jobEvents)
    .values({
      id: event.id,
      jobId: event.jobId,
      type: event.type,
      message: event.message,
      dataJson: event.dataJson,
      createdAt: event.createdAt,
    })
    .run();

  return event;
}

/**
 * 删除 created_at 早于 cutoff 的 job_events，止住 job_events 表无界增长。
 * 返回删除行数。保留近期事件供 SSE 续播（保留窗口远大于单条流的最大寿命）。
 * 注：DELETE 按 created_at 过滤为全表扫描——不为此单列建索引（避免拖累热路径
 * appendJobEvent 的写入成本），靠保留窗口把表维持在小规模即可。
 */
export function pruneJobEvents(cutoffIso: string): number {
  const sqlite = getRawDb();
  const result = sqlite
    .prepare(`DELETE FROM job_events WHERE created_at < ?`)
    .run(cutoffIso);
  return result.changes;
}

export function getJobEvents(jobId: string, afterId?: string): JobEvent[] {
  if (afterId) {
    const sqlite = getRawDb();
    const rows = sqlite.prepare(`
      SELECT je.*
      FROM job_events je
      WHERE je.job_id = ?
        AND (je.created_at, je.id) > (
          SELECT created_at, id FROM job_events WHERE id = ?
        )
      ORDER BY je.created_at ASC, je.id ASC
    `).all(jobId, afterId) as Array<{
      id: string; job_id: string; type: string; message: string;
      data_json: string | null; created_at: string;
    }>;

    if (rows.length > 0 || sqlite.prepare(`SELECT 1 FROM job_events WHERE id = ?`).get(afterId)) {
      return rows.map((row) => ({
        id: row.id,
        jobId: row.job_id,
        type: row.type,
        message: row.message,
        dataJson: row.data_json ?? null,
        createdAt: row.created_at,
      }));
    }
  }

  const db = getDb();
  const rows = db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(asc(jobEvents.createdAt), asc(jobEvents.id))
    .all();

  return rows.map(rowToJobEvent);
}

interface JobRow {
  id: string;
  type: string;
  status: string;
  subject_id: string | null;
  params_json: string;
  result_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  attempt_count: number | null;
}

function rowToJobFromRaw(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as Job['type'],
    status: row.status as Job['status'],
    subjectId: row.subject_id ?? null,
    paramsJson: row.params_json ?? '{}',
    resultJson: row.result_json ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    attemptCount: row.attempt_count ?? 0,
  };
}

function rowToJob(row: typeof jobs.$inferSelect): Job {
  return {
    id: row.id,
    type: row.type as Job['type'],
    status: row.status as Job['status'],
    subjectId: row.subjectId ?? null,
    paramsJson: row.paramsJson ?? '{}',
    resultJson: row.resultJson ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    leaseExpiresAt: row.leaseExpiresAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    attemptCount: row.attemptCount ?? 0,
  };
}

function rowToJobEvent(row: typeof jobEvents.$inferSelect): JobEvent {
  return {
    id: row.id,
    jobId: row.jobId,
    type: row.type,
    message: row.message,
    dataJson: row.dataJson ?? null,
    createdAt: row.createdAt,
  };
}
