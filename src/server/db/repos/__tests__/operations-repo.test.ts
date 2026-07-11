import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operations-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { getRawDb } = await import('../../client');
  const db = getRawDb();
  const sub = db.prepare(
    `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
  );
  sub.run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  sub.run('s2', 'sub-b', 'Sub B', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  db.prepare(
    `INSERT INTO jobs (id, type, status, subject_id, created_at) VALUES (?,?,?,?,?)`,
  ).run('job-ing', 'ingest', 'completed', 's1', '2026-01-01T00:00:00Z');
  const insOp = db.prepare(
    `INSERT INTO operations (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
     VALUES (?,?,?,?,?,?,?)`,
  );
  // 插入顺序即 rowid 顺序；listForSubject 应按 rowid DESC 返回
  insOp.run('opA', 'job-ing', 's1', 'pre', 'shaA', '[]', 'applied'); // 有 jobs → jobType=ingest
  insOp.run('opB', 'edit-uuid', 's1', 'pre', 'shaB', '[]', 'applied'); // 无 jobs → jobType=null
  insOp.run('opP', 'jp', 's1', 'pre', null, '[]', 'pending'); // post_head NULL → 排除
  insOp.run('opX', 'jx', 's2', 'pre', 'shaX', '[]', 'applied'); // 其它 subject → 排除
  insOp.run('opR', 'jr', 's1', 'pre', 'shaR', '[]', 'reverted'); // reverted → 包含
  return import('../operations-repo');
}

describe('operations-repo', () => {
  it('listForSubject：仅本 subject + post_head 非空 + applied/reverted，按 rowid 倒序', async () => {
    const repo = await setup();
    expect(repo.listForSubject('s1').map((r) => r.id)).toEqual(['opR', 'opB', 'opA']);
  });

  it('listForSubject：LEFT JOIN 出 jobType（同步编辑无 jobs 行 → null）', async () => {
    const repo = await setup();
    const rows = repo.listForSubject('s1');
    expect(rows.find((r) => r.id === 'opA')?.jobType).toBe('ingest');
    expect(rows.find((r) => r.id === 'opB')?.jobType).toBeNull();
  });

  it('getById：返回任意 subject 的行；未知 id → null', async () => {
    const repo = await setup();
    expect(repo.getById('opX')?.subjectId).toBe('s2');
    expect(repo.getById('nope')).toBeNull();
  });

  it('markReverted：把状态改为 reverted', async () => {
    const repo = await setup();
    repo.markReverted('opA');
    expect(repo.getById('opA')?.status).toBe('reverted');
  });

  it('listAppliedForJob：只返回当前 job/subject 已提交 operation，按 rowid 正序', async () => {
    const repo = await setup();
    const { getRawDb } = await import('../../client');
    getRawDb()
      .prepare(
        `INSERT INTO operations
         (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run('opC', 'job-ing', 's1', 'pre', 'shaC', '[]', 'applied');

    expect(repo.listAppliedForJob('job-ing', 's1').map((row) => row.id)).toEqual([
      'opA',
      'opC',
    ]);
    expect(repo.listAppliedForJob('job-ing', 's2')).toEqual([]);
  });
});

describe('operations-repo：pruneOldOperations', () => {
  async function seedMany(count: number, subjectId: string, db: import('better-sqlite3').Database) {
    const insOp = db.prepare(
      `INSERT INTO operations (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < count; i++) {
      insOp.run(`${subjectId}-op-${i}`, `job-${i}`, subjectId, 'pre', `sha${i}`, '[]', 'applied');
    }
  }

  it('条数未超上限时不删除任何行', async () => {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    await seedMany(10, 's1', db);
    const repo = await import('../operations-repo');
    const removed = repo.pruneOldOperations(500);
    expect(removed).toBe(0);
    expect(repo.listForSubject('s1')).toHaveLength(10);
  });

  it('超出上限时只删多出的最旧行（按 rowid 排序保留最近的）', async () => {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    await seedMany(12, 's1', db);
    const repo = await import('../operations-repo');
    const removed = repo.pruneOldOperations(10);
    expect(removed).toBe(2);
    const remaining = repo.listForSubject('s1').map((r) => r.id);
    expect(remaining).toHaveLength(10);
    // 保留的是最新的 10 条（op-2..op-11），最旧的 op-0/op-1 被删
    expect(remaining).not.toContain('s1-op-0');
    expect(remaining).not.toContain('s1-op-1');
    expect(remaining).toContain('s1-op-11');
  });

  it('pending 行永不删除，即便远超上限', async () => {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const insOp = db.prepare(
      `INSERT INTO operations (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 5; i++) {
      insOp.run(`pending-${i}`, `job-${i}`, 's1', 'pre', null, '[]', 'pending');
    }
    const repo = await import('../operations-repo');
    const removed = repo.pruneOldOperations(0);
    expect(removed).toBe(0);
    const stillThere = db
      .prepare(`SELECT COUNT(*) AS n FROM operations WHERE status = 'pending'`)
      .get() as { n: number };
    expect(stillThere.n).toBe(5);
  });

  it('按 subject 隔离：只在同一 subject 内计数，不跨 subject 互相挤占', async () => {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run('s2', 'sub-b', 'Sub B', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    await seedMany(8, 's1', db);
    await seedMany(8, 's2', db);
    const repo = await import('../operations-repo');
    const removed = repo.pruneOldOperations(8);
    expect(removed).toBe(0);
    expect(repo.listForSubject('s1')).toHaveLength(8);
    expect(repo.listForSubject('s2')).toHaveLength(8);
  });
});
