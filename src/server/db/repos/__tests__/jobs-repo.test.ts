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
    repo.enqueueJob('ingest', { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' }, 's1');
    const j2 = repo.enqueueJob('ingest', { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' }, 's1');
    repo.enqueueJob('ingest', { sourceId: 'src-y', filename: 'b.md', subjectId: 's1' }, 's1');
    repo.enqueueJob('lint', { sourceId: 'src-x' }, 's1'); // 非 ingest 不算

    const hit = repo.findLatestIngestJobForSource('s1', 'src-x');
    expect(hit?.id).toBe(j2.id);
    expect(repo.findLatestIngestJobForSource('s1', 'src-zzz')).toBeNull();
  });

  it('不同 subject 不命中（subject 隔离）', async () => {
    const { repo } = await setupJobs();
    repo.enqueueJob('ingest', { sourceId: 'src-a', filename: 'a.md', subjectId: 's1' }, 's1');
    expect(repo.findLatestIngestJobForSource('s2', 'src-a')).toBeNull();
  });
});

describe('jobs-repo.requeueJobWithParams', () => {
  async function setupFailedIngestJob() {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);

    const repo = await import('../jobs-repo');
    const job = repo.enqueueJob(
      'ingest',
      { sourceId: 'src-1', filename: 'source.md', subjectId: 's1' },
      's1'
    );
    db.prepare(
      `UPDATE jobs
       SET status = 'failed', lease_expires_at = ?, heartbeat_at = ?, cancel_requested = 1
       WHERE id = ?`
    ).run('2026-07-13T12:02:00.000Z', '2026-07-13T12:00:00.000Z', job.id);
    db.prepare(
      `INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(job.id, 'writer-page', 'page-a', '{"content":"draft"}', NOW);

    return { db, repo, jobId: job.id };
  }

  it('原子合并处置上下文并重排 failed job，保留原参数和 ingest checkpoint', async () => {
    const { db, repo, jobId } = await setupFailedIngestJob();
    const remediationContext = {
      lintJobId: 'lint-1',
      findingIds: ['finding-2', 'finding-1'],
      action: 're-ingest',
    };

    const requeued = repo.requeueJobWithParams(jobId, { remediationContext });

    expect(requeued).toMatchObject({
      id: jobId,
      status: 'pending',
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
    expect(JSON.parse(requeued!.paramsJson)).toEqual({
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
      remediationContext,
    });
    expect(
      db.prepare(`SELECT cancel_requested FROM jobs WHERE id = ?`).get(jobId)
    ).toEqual({ cancel_requested: 0 });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM ingest_checkpoints WHERE job_id = ?`).get(jobId)
    ).toEqual({ count: 1 });
  });

  it('非 failed job 或不存在的 job 返回 null 且不修改状态和参数', async () => {
    const { repo } = await setupFailedIngestJob();
    const pending = repo.enqueueJob('lint', { marker: 'original' }, 's1');

    expect(repo.requeueJobWithParams(pending.id, { marker: 'patched' })).toBeNull();
    expect(repo.requeueJobWithParams('missing-job', { marker: 'patched' })).toBeNull();
    expect(repo.getJob(pending.id)).toMatchObject({
      status: 'pending',
      paramsJson: JSON.stringify({ marker: 'original' }),
    });
  });

  it('paramsJson 损坏时返回 null，不得重排为丢失原参数的任务', async () => {
    const { db, repo, jobId } = await setupFailedIngestJob();
    db.prepare(`UPDATE jobs SET params_json = ? WHERE id = ?`).run('{', jobId);

    expect(repo.requeueJobWithParams(jobId, { remediationContext: {} })).toBeNull();
    expect(repo.getJob(jobId)).toMatchObject({
      status: 'failed',
      paramsJson: '{',
    });
  });
});
