import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobs-repo-'));
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
  const insEv = db.prepare(
    `INSERT INTO job_events (id, job_id, type, message, data_json, created_at) VALUES (?,?,?,?,?,?)`
  );
  insEv.run('e-old1', 'j1', 't', 'm', null, '2026-01-01T00:00:00Z');
  insEv.run('e-old2', 'j1', 't', 'm', null, '2026-05-31T23:59:59Z');
  insEv.run('e-new1', 'j1', 't', 'm', null, '2026-06-20T00:00:00Z');
  insEv.run('e-new2', 'j2', 't', 'm', null, '2026-06-23T00:00:00Z');
  return import('../jobs-repo');
}

describe('jobs-repo.pruneJobEvents', () => {
  it('删除 created_at < cutoff 的事件，保留较新的，返回删除数', async () => {
    const repo = await setup();
    const removed = repo.pruneJobEvents('2026-06-01T00:00:00Z');
    expect(removed).toBe(2);
    expect(repo.getJobEvents('j1').map((e) => e.id)).toEqual(['e-new1']);
    expect(repo.getJobEvents('j2').map((e) => e.id)).toEqual(['e-new2']);
  });

  it('无过期事件 → 返回 0，全部保留', async () => {
    const repo = await setup();
    expect(repo.pruneJobEvents('2025-01-01T00:00:00Z')).toBe(0);
    expect(repo.getJobEvents('j1')).toHaveLength(3);
  });
});

const NOW = '2026-01-01T00:00:00Z';

describe('jobs-repo.findLatestIngestJobForSource', () => {
  async function setupJobs() {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const repo = await import('../jobs-repo');
    return { repo };
  }

  it('按 params.sourceId 精确匹配并取最新一条；无命中返回 null', async () => {
    const { repo } = await setupJobs();
    const j1 = repo.enqueueJob('ingest', { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' }, 's1');
    const j2 = repo.enqueueJob('ingest', { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' }, 's1');
    repo.enqueueJob('ingest', { sourceId: 'src-y', filename: 'b.md', subjectId: 's1' }, 's1');
    repo.enqueueJob('lint', { sourceId: 'src-x' }, 's1'); // 非 ingest 不算

    const hit = repo.findLatestIngestJobForSource('s1', 'src-x');
    expect(hit?.id).toBe(j2.id);
    expect([j1.id, j2.id]).toContain(hit!.id);
    expect(repo.findLatestIngestJobForSource('s1', 'src-zzz')).toBeNull();
  });

  it('不同 subject 不命中（subject 隔离）', async () => {
    const { repo } = await setupJobs();
    repo.enqueueJob('ingest', { sourceId: 'src-a', filename: 'a.md', subjectId: 's1' }, 's1');
    expect(repo.findLatestIngestJobForSource('s2', 'src-a')).toBeNull();
  });
});
