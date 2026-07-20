import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
import { ingestCheckpoints } from '../schema';
import type { CheckpointProgress } from '@/lib/contracts';

export interface CheckpointRow {
  kind: string;
  key: string;
  data: unknown;
}

export function getCheckpoints(jobId: string): CheckpointRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(ingestCheckpoints)
    .where(eq(ingestCheckpoints.jobId, jobId))
    .all();
  return rows.map((r) => ({ kind: r.kind, key: r.key, data: JSON.parse(r.dataJson) }));
}

export function putCheckpoint(jobId: string, kind: string, key: string, data: unknown): void {
  const sqlite = getRawDb();
  sqlite
    .prepare(
      `INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM jobs WHERE id = ? AND cancel_requested = 1
       )
       ON CONFLICT(job_id, kind, key) DO UPDATE SET
         data_json = excluded.data_json,
         created_at = excluded.created_at`,
    )
    .run(jobId, kind, key, JSON.stringify(data), new Date().toISOString(), jobId);
}

export function deleteCheckpoints(jobId: string): void {
  const sqlite = getRawDb();
  sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id = ?`).run(jobId);
}

/** T1.6：丢弃单条检查点条目（用于 WriterConflict 场景撤销已落盘的冲突页）。 */
export function deleteCheckpoint(jobId: string, kind: string, key: string): void {
  const sqlite = getRawDb();
  sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id = ? AND kind = ? AND key = ?`).run(jobId, kind, key);
}

export function getProgress(jobId: string): CheckpointProgress | null {
  const sqlite = getRawDb();
  const progress = sqlite
    .prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN kind = 'plan' THEN 1 ELSE 0 END), 0) AS plans,
        COALESCE(SUM(CASE WHEN kind = 'chunk-summary' THEN 1 ELSE 0 END), 0) AS chunk_summaries,
        COALESCE(SUM(CASE WHEN kind = 'writer-page' THEN 1 ELSE 0 END), 0) AS writer_pages,
        MAX(CASE WHEN kind = 'plan' AND key = '' THEN data_json END) AS plan_json
      FROM ingest_checkpoints
      WHERE job_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM jobs WHERE id = ? AND cancel_requested = 1
        )
    `)
    .get(jobId, jobId) as {
      total: number;
      plans: number;
      chunk_summaries: number;
      writer_pages: number;
      plan_json: string | null;
    };
  if (progress.total === 0) return null;

  const plan = progress.plans > 0;
  const chunkSummaries = progress.chunk_summaries;
  const writerPages = progress.writer_pages;

  let totalPages: number | null = null;
  if (plan && progress.plan_json) {
    try {
      const parsed = JSON.parse(progress.plan_json) as { plan?: { pages?: unknown[] } };
      if (parsed?.plan?.pages && Array.isArray(parsed.plan.pages)) {
        totalPages = parsed.plan.pages.length;
      }
    } catch {
      // plan 反序列化失败时 totalPages 留 null（不致命）
    }
  }

  return { plan, chunkSummaries, writerPages, totalPages };
}
