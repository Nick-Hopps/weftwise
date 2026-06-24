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
          lease_expires_at = ?, attempt_count = COALESCE(attempt_count, 0) + 1
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
          lease_expires_at = ?, attempt_count = COALESCE(attempt_count, 0) + 1
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
    UPDATE jobs SET status = 'pending', lease_expires_at = NULL, heartbeat_at = NULL
    WHERE id = ?
  `).run(jobId);
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
