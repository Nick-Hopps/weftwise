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
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_id, kind, key) DO UPDATE SET
         data_json = excluded.data_json,
         created_at = excluded.created_at`,
    )
    .run(jobId, kind, key, JSON.stringify(data), new Date().toISOString());
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
  const counts = sqlite
    .prepare(`SELECT kind, COUNT(*) AS n FROM ingest_checkpoints WHERE job_id = ? GROUP BY kind`)
    .all(jobId) as Array<{ kind: string; n: number }>;
  if (counts.length === 0) return null;

  let plan = false;
  let chunkSummaries = 0;
  let writerPages = 0;
  for (const c of counts) {
    if (c.kind === 'plan') plan = c.n > 0;
    else if (c.kind === 'chunk-summary') chunkSummaries = c.n;
    else if (c.kind === 'writer-page') writerPages = c.n;
  }

  let totalPages: number | null = null;
  if (plan) {
    // plan 每个 job 仅一份，落盘时 key 固定为空串（见 checkpoint.ts putPlan）
    const row = sqlite
      .prepare(`SELECT data_json FROM ingest_checkpoints WHERE job_id = ? AND kind = 'plan' AND key = ''`)
      .get(jobId) as { data_json: string } | undefined;
    if (row) {
      try {
        const parsed = JSON.parse(row.data_json) as { plan?: { pages?: unknown[] } };
        if (parsed?.plan?.pages && Array.isArray(parsed.plan.pages)) {
          totalPages = parsed.plan.pages.length;
        }
      } catch {
        // plan 反序列化失败时 totalPages 留 null（不致命）
      }
    }
  }

  return { plan, chunkSummaries, writerPages, totalPages };
}
