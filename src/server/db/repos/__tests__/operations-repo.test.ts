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
});
