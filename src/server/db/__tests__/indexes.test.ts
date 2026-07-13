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

  it('jobs 最新 subject lint 与全局 lint 按完成时间走稳定排序索引', async () => {
    const db = await bootstrap();
    const subjectLatest = planDetail(
      db,
      `SELECT * FROM jobs
       WHERE subject_id = ? AND type = ? AND status = ?
       ORDER BY completed_at DESC, id DESC LIMIT 1`,
      'general',
      'lint',
      'completed',
    );
    const globalLatest = planDetail(
      db,
      `SELECT * FROM jobs
       WHERE subject_id IS NULL AND type = ? AND status = ?
       ORDER BY completed_at DESC, id DESC LIMIT 1`,
      'lint',
      'completed',
    );

    expect(subjectLatest).toMatch(/jobs_subject_type_status_completed_id_idx/);
    expect(globalLatest).toMatch(/jobs_subject_type_status_completed_id_idx/);
    expect(subjectLatest).not.toMatch(/USE TEMP B-TREE/);
    expect(globalLatest).not.toMatch(/USE TEMP B-TREE/);
    expect(subjectLatest).not.toMatch(/SCAN jobs\b/);
    expect(globalLatest).not.toMatch(/SCAN jobs\b/);
  });

  it('jobs 最近状态快照在 subject 与全量路径均走稳定排序索引', async () => {
    const db = await bootstrap();
    const subjectRecent = planDetail(
      db,
      `SELECT * FROM jobs WHERE subject_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      'general',
    );
    const allRecent = planDetail(
      db,
      `SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT 200`,
    );

    expect(subjectRecent).toMatch(/jobs_subject_created_id_idx/);
    expect(allRecent).toMatch(/jobs_created_id_idx/);
    expect(subjectRecent).not.toMatch(/USE TEMP B-TREE/);
    expect(allRecent).not.toMatch(/USE TEMP B-TREE/);
  });

  it('remediation CAS 候选查询按 subject/type/status/completed_at 走索引', async () => {
    const db = await bootstrap();
    const detail = planDetail(
      db,
      `SELECT * FROM jobs
       WHERE subject_id = ? AND type = ?
         AND (status IN ('pending', 'running')
           OR (status = 'completed'
             AND (? IS NULL OR completed_at IS NULL OR completed_at > ?)))`,
      'general',
      'fix',
      '2026-07-13T10:00:00.000Z',
      '2026-07-13T10:00:00.000Z',
    );

    expect(detail).toMatch(/jobs_subject_type_status_completed_id_idx/);
    expect(detail).not.toMatch(/SCAN jobs\b/);
  });

  it('同源 ingest 最新任务查询走 JSON 表达式索引且损坏历史参数安全', async () => {
    const db = await bootstrap();
    expect(() => db.prepare(`
      INSERT INTO jobs (id, type, status, subject_id, params_json, created_at)
      VALUES (?, 'ingest', 'failed', NULL, ?, ?)
    `).run('invalid-json-job', '{', '2026-07-13T09:00:00.000Z')).not.toThrow();

    const detail = planDetail(
      db,
      `SELECT * FROM jobs
       WHERE subject_id = ? AND type = 'ingest'
         AND CASE WHEN json_valid(params_json)
           THEN json_extract(params_json, '$.sourceId') END = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      'general',
      'source-1',
    );

    expect(detail).toMatch(/jobs_subject_ingest_source_created_id_idx/);
    expect(detail).not.toMatch(/USE TEMP B-TREE/);
    expect(detail).not.toMatch(/SCAN jobs\b/);
  });

  it('同源 ingest 全量 active 与任一 active 查询都走 source+status 表达式索引', async () => {
    const db = await bootstrap();
    const activeSql = `SELECT * FROM jobs
       WHERE subject_id = ? AND type = 'ingest'
         AND CASE WHEN json_valid(params_json)
           THEN json_extract(params_json, '$.sourceId') END = ?
         AND status IN ('pending', 'running')`;
    const allDetail = planDetail(
      db,
      activeSql,
      'general',
      'source-1',
    );
    const oneDetail = planDetail(
      db,
      `${activeSql} LIMIT 1`,
      'general',
      'source-1',
    );

    for (const detail of [allDetail, oneDetail]) {
      expect(detail).toMatch(/jobs_subject_ingest_source_status_created_id_idx/);
      expect(detail).not.toMatch(/SCAN jobs\b/);
    }
  });

  it('pending_actions 按会话恢复与按状态过期清理均走索引', async () => {
    const db = await bootstrap();
    const conversation = planDetail(
      db,
      `SELECT id FROM pending_actions
       WHERE conversation_id = ? AND status = ? ORDER BY created_at DESC`,
      'c1',
      'pending',
    );
    expect(conversation).toMatch(/USING (COVERING )?INDEX/);

    const expiry = planDetail(
      db,
      `SELECT id FROM pending_actions WHERE status = ? AND expires_at < ?`,
      'pending',
      '2026-07-11T00:00:00.000Z',
    );
    expect(expiry).toMatch(/USING (COVERING )?INDEX/);
  });
});
