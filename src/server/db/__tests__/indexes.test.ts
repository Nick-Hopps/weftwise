import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-indexes-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function bootstrap(): Promise<Database.Database> {
  const { getRawDb } = await import('../client');
  return getRawDb();
}

/** 拼接 EXPLAIN QUERY PLAN 各行的 detail，便于断言是否走索引。 */
function planDetail(db: Database.Database, sql: string, ...params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join(' | ');
}

describe('热路径查询走索引（非全表扫描）', () => {
  it('wiki_links 反向链接查找（target_subject_id, target_slug）走索引', async () => {
    const db = await bootstrap();
    const detail = planDetail(
      db,
      `SELECT id FROM wiki_links WHERE target_subject_id = ? AND target_slug = ?`,
      'general',
      'x'
    );
    expect(detail).toMatch(/USING (COVERING )?INDEX/);
    expect(detail).not.toMatch(/SCAN wiki_links\b/);
  });

  it('wiki_links 出链/删除查找（subject_id, source_slug）走索引', async () => {
    const db = await bootstrap();
    const detail = planDetail(
      db,
      `SELECT id FROM wiki_links WHERE subject_id = ? AND source_slug = ?`,
      'general',
      'x'
    );
    expect(detail).toMatch(/USING (COVERING )?INDEX/);
    expect(detail).not.toMatch(/SCAN wiki_links\b/);
  });

  it('job_events 按 job_id 续播查找走索引', async () => {
    const db = await bootstrap();
    const detail = planDetail(
      db,
      `SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC, id ASC`,
      'j1'
    );
    expect(detail).toMatch(/USING (COVERING )?INDEX/);
    expect(detail).not.toMatch(/SCAN job_events\b/);
  });

  it('jobs 按 status/type 轮询与列表查找走索引', async () => {
    const db = await bootstrap();
    const detail = planDetail(
      db,
      `SELECT id FROM jobs WHERE status = ? AND type = ? ORDER BY created_at ASC`,
      'pending',
      'ingest'
    );
    expect(detail).toMatch(/USING (COVERING )?INDEX/);
  });
});
