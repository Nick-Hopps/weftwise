import { eq, and, asc } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
import { jobs, jobEvents } from '../schema';
import type { Job, JobEvent } from '@/lib/contracts';

export function enqueueJob(
  type: Job['type'],
  params: Record<string, unknown> = {}
): Job {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const job: Job = {
    id,
    type,
    status: 'pending',
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

  // Atomic claim: grab pending jobs OR running jobs with expired leases
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
}

export function listJobs(filter?: JobFilter): Job[] {
  const db = getDb();

  let query = db.select().from(jobs).$dynamic();

  if (filter?.status && filter?.type) {
    query = query.where(
      and(eq(jobs.status, filter.status), eq(jobs.type, filter.type))
    );
  } else if (filter?.status) {
    query = query.where(eq(jobs.status, filter.status));
  } else if (filter?.type) {
    query = query.where(eq(jobs.type, filter.type));
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

  // Extract AI SDK diagnostic fields (NoObjectGeneratedError, etc.)
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

export function getJobEvents(jobId: string, afterId?: string): JobEvent[] {
  if (afterId) {
    // Efficient cursor-based query: find the cursor event's timestamp, then
    // fetch only events strictly after it, avoiding a full-table scan + JS slice.
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

    // If cursor not found (subquery returns nothing), fall through to return all events
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

// ── helpers ───────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  type: string;
  status: string;
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
