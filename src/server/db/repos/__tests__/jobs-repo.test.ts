import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@/lib/contracts';

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

describe('jobs-repo.listRecentJobs', () => {
  async function setupRecentJobs() {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const insert = db.prepare(
      `INSERT INTO jobs
       (id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count)
       VALUES (?, 'lint', 'completed', ?, '{}', '{}', ?, NULL, ?, NULL, NULL, 0)`,
    );
    insert.run('global-old', null, '2026-07-13T09:00:00.000Z', '2026-07-13T09:01:00.000Z');
    insert.run('global-tie-a', null, '2026-07-13T10:00:00.000Z', '2026-07-13T10:01:00.000Z');
    insert.run('global-tie-z', null, '2026-07-13T10:00:00.000Z', '2026-07-13T10:01:00.000Z');
    insert.run('subject-new', 's1', '2026-07-13T11:00:00.000Z', '2026-07-13T11:01:00.000Z');
    return import('../jobs-repo');
  }

  it('显式 subjectId:null 仅返回全局任务', async () => {
    const repo = await setupRecentJobs();

    expect(repo.listRecentJobs({ subjectId: null }, 10).map((job) => job.id))
      .toEqual(['global-tie-z', 'global-tie-a', 'global-old']);
    expect(repo.listJobs({ subjectId: null }).map((job) => job.id))
      .toEqual(expect.arrayContaining(['global-old', 'global-tie-a', 'global-tie-z']));
    expect(repo.listJobs({ subjectId: null })).toHaveLength(3);
  });

  it('createdAt 相同时以 id DESC 稳定决胜', async () => {
    const repo = await setupRecentJobs();

    expect(repo.listRecentJobs(undefined, 4).map((job) => job.id))
      .toEqual(['subject-new', 'global-tie-z', 'global-tie-a', 'global-old']);
  });

  it('LIMIT 在 SQL 结果集生效并严格限制返回行数', async () => {
    const repo = await setupRecentJobs();

    const result = repo.listRecentJobs({ type: 'lint', status: 'completed' }, 2);
    expect(result).toHaveLength(2);
    expect(result.map((job) => job.id)).toEqual(['subject-new', 'global-tie-z']);
  });
});

describe('jobs-repo.listLatestCompletedLint', () => {
  async function setupLatestLintJobs() {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const insert = db.prepare(
      `INSERT INTO jobs
       (id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count)
       VALUES (?, ?, ?, ?, '{}', '{}', ?, NULL, ?, NULL, NULL, 0)`,
    );
    return { db, insert, repo: await import('../jobs-repo') };
  }

  it('按 completedAt 而非 createdAt 选择 subject 最新 completed lint', async () => {
    const { insert, repo } = await setupLatestLintJobs();
    insert.run(
      'lint-a', 'lint', 'completed', 's1',
      '2026-07-13T09:00:00.000Z', '2026-07-13T12:00:00.000Z',
    );
    insert.run(
      'lint-b', 'lint', 'completed', 's1',
      '2026-07-13T11:00:00.000Z', '2026-07-13T10:00:00.000Z',
    );
    insert.run(
      'lint-running', 'lint', 'running', 's1',
      '2026-07-13T13:00:00.000Z', null,
    );
    insert.run(
      'fix-late', 'fix', 'completed', 's1',
      '2026-07-13T13:00:00.000Z', '2026-07-13T14:00:00.000Z',
    );

    expect(repo.listLatestCompletedLint('s1')?.id).toBe('lint-a');
  });

  it('completedAt 相同时以 id DESC 稳定决胜', async () => {
    const { insert, repo } = await setupLatestLintJobs();
    insert.run(
      'lint-tie-a', 'lint', 'completed', 's1',
      '2026-07-13T11:00:00.000Z', '2026-07-13T12:00:00.000Z',
    );
    insert.run(
      'lint-tie-z', 'lint', 'completed', 's1',
      '2026-07-13T09:00:00.000Z', '2026-07-13T12:00:00.000Z',
    );

    expect(repo.listLatestCompletedLint('s1')?.id).toBe('lint-tie-z');
  });

  it('subjectId:null 只选全局 completed lint，无命中返回 null', async () => {
    const { insert, repo } = await setupLatestLintJobs();
    insert.run(
      'global-lint', 'lint', 'completed', null,
      '2026-07-13T09:00:00.000Z', '2026-07-13T12:00:00.000Z',
    );
    insert.run(
      'scoped-lint', 'lint', 'completed', 's1',
      '2026-07-13T10:00:00.000Z', '2026-07-13T13:00:00.000Z',
    );

    expect(repo.listLatestCompletedLint(null)?.id).toBe('global-lint');
    expect(repo.listLatestCompletedLint('missing-subject')).toBeNull();
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
    return { db, repo };
  }

  it('按 params.sourceId 精确匹配并取最新一条；无命中返回 null', async () => {
    const { db, repo } = await setupJobs();
    const j1 = repo.enqueueJob('ingest', { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' }, 's1');
    const j2 = repo.enqueueJob('ingest', { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' }, 's1');
    // 明确时间顺序，避免同毫秒入队时依赖 SQLite 未声明的 tie-break。
    db.prepare(`UPDATE jobs SET created_at = ? WHERE id = ?`)
      .run('2026-07-13T10:00:00.000Z', j1.id);
    db.prepare(`UPDATE jobs SET created_at = ? WHERE id = ?`)
      .run('2026-07-13T10:00:01.000Z', j2.id);
    db.prepare(`UPDATE jobs SET status = 'completed', completed_at = created_at WHERE id IN (?, ?)`)
      .run(j1.id, j2.id);
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

  it('更老的同源 active 优先于更新的 terminal，供删除路由保持 in-flight 守卫', async () => {
    const { db, repo } = await setupJobs();
    const active = repo.enqueueJob('ingest', {
      sourceId: 'src-active', filename: 'a.md', subjectId: 's1',
    }, 's1');
    const terminal = repo.enqueueJob('ingest', {
      sourceId: 'src-active', filename: 'a.md', subjectId: 's1',
    }, 's1');
    db.prepare(`UPDATE jobs SET created_at = ? WHERE id = ?`)
      .run('2026-07-13T10:00:00.000Z', active.id);
    db.prepare(`
      UPDATE jobs SET status = 'completed', created_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      '2026-07-13T11:00:00.000Z',
      '2026-07-13T11:01:00.000Z',
      terminal.id,
    );

    expect(repo.findLatestIngestJobForSource('s1', 'src-active'))
      .toMatchObject({ id: active.id, status: 'pending' });
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
    const claimed = repo.claimNextJob('ingest');
    if (claimed?.id !== job.id) throw new Error('测试任务未被正确领取');
    repo.failJob(job.id, new Error('boom'));
    const failed = repo.getJob(job.id);
    if (!failed) throw new Error('失败任务不存在');
    db.prepare(
      `UPDATE jobs
       SET lease_expires_at = ?, heartbeat_at = ?
       WHERE id = ?`
    ).run('2026-07-13T12:02:00.000Z', '2026-07-13T12:00:00.000Z', job.id);
    db.prepare(
      `INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(job.id, 'writer-page', 'page-a', '{"content":"draft"}', NOW);

    return { db, repo, jobId: job.id, failed };
  }

  it('原子合并处置上下文并重排 failed job，保留原参数和 ingest checkpoint', async () => {
    const { db, repo, jobId, failed } = await setupFailedIngestJob();
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
      resultJson: failed.resultJson,
      completedAt: failed.completedAt,
      startedAt: failed.startedAt,
      attemptCount: failed.attemptCount,
    });
    expect(failed).toMatchObject({ status: 'failed', attemptCount: 1 });
    expect(failed.resultJson).not.toBeNull();
    expect(failed.completedAt).not.toBeNull();
    expect(failed.startedAt).not.toBeNull();
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

  it('已取消的 failed job 不得通过参数重排复活', async () => {
    const { db, repo, jobId } = await setupFailedIngestJob();
    expect(repo.requestCancel(jobId)).toBe('cancelled');

    expect(repo.requeueJobWithParams(jobId, { marker: 'patched' })).toBeNull();

    const row = db
      .prepare(
        `SELECT status, cancel_requested, params_json, result_json FROM jobs WHERE id = ?`
      )
      .get(jobId) as {
        status: string;
        cancel_requested: number;
        params_json: string;
        result_json: string;
      };
    expect(row.status).toBe('failed');
    expect(row.cancel_requested).toBe(1);
    expect(JSON.parse(row.params_json)).not.toHaveProperty('marker');
    expect(JSON.parse(row.result_json)).toMatchObject({ cancelled: true });
  });

  it('resultJson 已标记 cancelled 时防御性拒绝重排', async () => {
    const { db, repo, jobId } = await setupFailedIngestJob();
    const cancelledResult = JSON.stringify({
      error: { message: 'Cancelled by user' },
      cancelled: true,
    });
    db.prepare(
      `UPDATE jobs SET cancel_requested = 0, result_json = ? WHERE id = ?`
    ).run(cancelledResult, jobId);

    expect(repo.requeueJobWithParams(jobId, { marker: 'patched' })).toBeNull();
    expect(repo.getJob(jobId)).toMatchObject({
      status: 'failed',
      resultJson: cancelledResult,
    });
    expect(
      db.prepare(`SELECT cancel_requested FROM jobs WHERE id = ?`).get(jobId)
    ).toEqual({ cancel_requested: 0 });
    expect(JSON.parse(repo.getJob(jobId)!.paramsJson)).not.toHaveProperty('marker');
  });

  it('连续两个重排仅首个成功，后续调用不得覆盖参数', async () => {
    const { repo, jobId } = await setupFailedIngestJob();

    expect(repo.requeueJobWithParams(jobId, { marker: 'first' })).not.toBeNull();
    expect(repo.requeueJobWithParams(jobId, { marker: 'second' })).toBeNull();
    expect(JSON.parse(repo.getJob(jobId)!.paramsJson)).toMatchObject({
      marker: 'first',
    });
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

describe('jobs-repo.getOrCreateJobAtomic', () => {
  it('在 BEGIN IMMEDIATE 写锁内重检 matcher，第二次相同 context 只复用一条 job', async () => {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const repo = await import('../jobs-repo');
    const { findDuplicateRemediationJob } = await import('../../../services/remediation-context');
    const context = {
      lintJobId: 'lint-1',
      findingIds: ['a'.repeat(64)],
      action: 'fix' as const,
    };
    const matcher = vi.fn((jobs) => {
      expect(db.inTransaction).toBe(true);
      return findDuplicateRemediationJob(
        jobs,
        's1',
        context,
        '2026-07-13T10:00:00.000Z',
      );
    });
    const beforeCreate = vi.fn(() => {
      expect(db.inTransaction).toBe(true);
    });
    const input = {
      type: 'fix' as const,
      params: { subjectId: 's1', remediationContext: context },
      subjectId: 's1',
      lintRanAt: '2026-07-13T10:00:00.000Z',
      matcher,
      beforeCreate,
    };

    const first = repo.getOrCreateJobAtomic(input);
    const second = repo.getOrCreateJobAtomic(input);

    expect(first).toMatchObject({ deduplicated: false });
    expect(second).toMatchObject({
      deduplicated: true,
      job: { id: first.job.id },
    });
    expect(matcher).toHaveBeenCalledTimes(2);
    expect(beforeCreate).toHaveBeenCalledTimes(1);
    expect(repo.listJobs({ subjectId: 's1' })).toHaveLength(1);
  });

  it('matcher 只接收同类型在途或 lint 后完成候选，不扫描大量历史噪声', async () => {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const repo = await import('../jobs-repo');
    const context = {
      lintJobId: 'lint-1',
      findingIds: ['a'.repeat(64)],
      action: 'fix' as const,
    };
    const insert = db.prepare(`
      INSERT INTO jobs (
        id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count
      ) VALUES (?, ?, ?, 's1', ?, '{}', ?, NULL, ?, NULL, NULL, 0)
    `);
    const insertNoise = db.transaction(() => {
      for (let index = 0; index < 300; index += 1) {
        const createdAt = new Date(Date.parse('2026-07-01T00:00:00.000Z') + index).toISOString();
        insert.run(
          `old-fix-${index}`,
          'fix',
          'completed',
          JSON.stringify({ remediationContext: context }),
          createdAt,
          '2026-07-12T09:00:00.000Z',
        );
        insert.run(
          `other-type-${index}`,
          'curate',
          'pending',
          JSON.stringify({ remediationContext: { ...context, action: 'curate' } }),
          createdAt,
          null,
        );
      }
    });
    insertNoise();
    const reusable = repo.enqueueJob('fix', {
      subjectId: 's1',
      remediationContext: context,
    }, 's1');
    const seenCandidateIds: string[][] = [];

    const result = repo.getOrCreateJobAtomic({
      type: 'fix',
      params: { subjectId: 's1', remediationContext: context },
      subjectId: 's1',
      lintRanAt: '2026-07-13T10:00:00.000Z',
      matcher: (candidates) => {
        seenCandidateIds.push(candidates.map((candidate) => candidate.id));
        return candidates.find((candidate) => candidate.id === reusable.id) ?? null;
      },
    });

    expect(result).toMatchObject({ deduplicated: true, job: { id: reusable.id } });
    expect(seenCandidateIds).toEqual([[reusable.id]]);
  });

  it('两个并发幂等入口最终只创建一条相同 context job', async () => {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const repo = await import('../jobs-repo');
    const { findDuplicateRemediationJob } = await import('../../../services/remediation-context');
    const context = {
      lintJobId: 'lint-1',
      findingIds: ['a'.repeat(64)],
      action: 'fix' as const,
    };
    const input = {
      type: 'fix' as const,
      params: { subjectId: 's1', remediationContext: context },
      subjectId: 's1',
      lintRanAt: '2026-07-13T10:00:00.000Z',
      matcher: (candidates: Job[]) => findDuplicateRemediationJob(
        candidates,
        's1',
        context,
        '2026-07-13T10:00:00.000Z',
      ),
    };

    const [left, right] = await Promise.all([
      Promise.resolve().then(() => repo.getOrCreateJobAtomic(input)),
      Promise.resolve().then(() => repo.getOrCreateJobAtomic(input)),
    ]);

    expect(new Set([left.job.id, right.job.id]).size).toBe(1);
    expect([left.deduplicated, right.deduplicated].sort()).toEqual([false, true]);
    expect(repo.listJobs({ type: 'fix', subjectId: 's1' })).toHaveLength(1);
  });

  it('completedAt 缺失或 lintRanAt 缺失时仍把 completed job 交给 matcher', async () => {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const repo = await import('../jobs-repo');
    const completed = repo.enqueueJob('fix', { marker: 'completed' }, 's1');
    db.prepare(`UPDATE jobs SET status = 'completed', completed_at = NULL WHERE id = ?`)
      .run(completed.id);
    const seenWithLint: string[][] = [];
    const seenWithoutLint: string[][] = [];
    const baseInput = {
      type: 'fix' as const,
      params: { marker: 'new' },
      subjectId: 's1',
    };

    repo.getOrCreateJobAtomic({
      ...baseInput,
      lintRanAt: '2026-07-13T10:00:00.000Z',
      matcher: (candidates) => {
        seenWithLint.push(candidates.map((candidate) => candidate.id));
        return candidates[0] ?? null;
      },
    });
    db.prepare(`UPDATE jobs SET completed_at = ? WHERE id = ?`)
      .run('2026-07-01T10:00:00.000Z', completed.id);
    repo.getOrCreateJobAtomic({
      ...baseInput,
      lintRanAt: null,
      matcher: (candidates) => {
        seenWithoutLint.push(candidates.map((candidate) => candidate.id));
        return candidates[0] ?? null;
      },
    });

    expect(seenWithLint).toEqual([[completed.id]]);
    expect(seenWithoutLint).toEqual([[completed.id]]);
  });
});

describe('jobs-repo.reingestSourceAtomic', () => {
  async function setupAtomicReingest() {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const repo = await import('../jobs-repo');
    const context = {
      lintJobId: 'lint-1',
      findingIds: ['a'.repeat(64)],
      action: 're-ingest' as const,
    };
    const params = {
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
      remediationContext: context,
    };
    const isDuplicateInFlight = (job: { paramsJson: string }) => {
      const parsed = JSON.parse(job.paramsJson) as { remediationContext?: unknown };
      return JSON.stringify(parsed.remediationContext) === JSON.stringify(context);
    };
    return { db, repo, context, params, isDuplicateInFlight };
  }

  it('第二次同 source/context 原子复用 pending ingest，不创建重复 job', async () => {
    const { repo, context, params, isDuplicateInFlight } = await setupAtomicReingest();

    const first = repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
      isDuplicateInFlight,
    });
    const second = repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
      isDuplicateInFlight,
    });

    expect(first).toMatchObject({ kind: 'created' });
    if (first.kind !== 'created') throw new Error('首个调用应创建 ingest job');
    expect(second).toMatchObject({
      kind: 'in-flight',
      deduplicated: true,
      job: { id: first.job.id },
    });
    expect(repo.listJobs({ type: 'ingest', subjectId: 's1' })).toHaveLength(1);
  });

  it('无 context matcher 的专用路径仍把在途任务标为非幂等 in-flight', async () => {
    const { repo, params } = await setupAtomicReingest();
    const first = repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: {},
    });
    if (first.kind !== 'created') throw new Error('首个调用应创建 ingest job');

    expect(repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: {},
    })).toMatchObject({
      kind: 'in-flight',
      deduplicated: false,
      job: { id: first.job.id },
    });
  });

  it('更老同源 active 不被更新 terminal 遮蔽，禁止新建第三条 ingest', async () => {
    const { db, repo, context, params, isDuplicateInFlight } = await setupAtomicReingest();
    const active = repo.enqueueJob('ingest', params, 's1');
    const terminal = repo.enqueueJob('ingest', params, 's1');
    db.prepare(`UPDATE jobs SET created_at = ? WHERE id = ?`)
      .run('2026-07-13T10:00:00.000Z', active.id);
    db.prepare(`
      UPDATE jobs SET status = 'completed', created_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      '2026-07-13T11:00:00.000Z',
      '2026-07-13T11:01:00.000Z',
      terminal.id,
    );

    const result = repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
      isDuplicateInFlight,
    });

    expect(result).toMatchObject({
      kind: 'in-flight',
      deduplicated: true,
      job: { id: active.id },
    });
    expect(repo.listJobs({ type: 'ingest', subjectId: 's1' })).toHaveLength(2);
  });

  it('同源存在多个 active 时优先复用不是索引首条的 exact-context job', async () => {
    const { db, repo, context, params, isDuplicateInFlight } = await setupAtomicReingest();
    const exact = repo.enqueueJob('ingest', params, 's1');
    expect(repo.claimNextJob('ingest')?.id).toBe(exact.id);
    const other = repo.enqueueJob('ingest', {
      ...params,
      remediationContext: {
        ...context,
        findingIds: ['b'.repeat(64)],
      },
    }, 's1');
    db.prepare(`UPDATE jobs SET created_at = ? WHERE id = ?`)
      .run('2026-07-13T10:00:00.000Z', exact.id);
    db.prepare(`UPDATE jobs SET created_at = ? WHERE id = ?`)
      .run('2026-07-13T11:00:00.000Z', other.id);

    const result = repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
      isDuplicateInFlight,
    });

    expect(result).toMatchObject({
      kind: 'in-flight',
      deduplicated: true,
      job: { id: exact.id },
    });
    expect(repo.listJobs({ type: 'ingest', subjectId: 's1' })).toHaveLength(2);
  });

  it('failed 重排与 job:retrying 事件同事务成功落库', async () => {
    const { repo, context, params, isDuplicateInFlight } = await setupAtomicReingest();
    const failed = repo.enqueueJob('ingest', {
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
    }, 's1');
    expect(repo.claimNextJob('ingest')?.id).toBe(failed.id);
    repo.failJob(failed.id, new Error('boom'));

    const result = repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
      isDuplicateInFlight,
    });

    expect(result).toMatchObject({ kind: 'requeued', job: { id: failed.id, status: 'pending' } });
    expect(JSON.parse(repo.getJob(failed.id)!.paramsJson)).toMatchObject({ remediationContext: context });
    expect(repo.getJobEvents(failed.id)).toEqual([
      expect.objectContaining({
        jobId: failed.id,
        type: 'job:retrying',
        message: 'Manual re-ingest — resuming from checkpoint',
        dataJson: JSON.stringify({ manual: true }),
      }),
    ]);
  });

  it('大量异源与损坏 JSON 历史下仍只重排最新同源 failed job', async () => {
    const { db, repo, context, params } = await setupAtomicReingest();
    const insert = db.prepare(`
      INSERT INTO jobs (
        id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count
      ) VALUES (?, 'ingest', 'completed', 's1', ?, '{}', ?, NULL, ?, NULL, NULL, 0)
    `);
    const insertNoise = db.transaction(() => {
      for (let index = 0; index < 400; index += 1) {
        const createdAt = new Date(Date.parse('2026-07-01T00:00:00.000Z') + index).toISOString();
        insert.run(
          `ingest-noise-${index}`,
          index % 25 === 0 ? '{' : JSON.stringify({ sourceId: `other-${index}` }),
          createdAt,
          createdAt,
        );
      }
    });
    insertNoise();
    const failed = repo.enqueueJob('ingest', {
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
    }, 's1');
    expect(repo.claimNextJob('ingest')?.id).toBe(failed.id);
    repo.failJob(failed.id, new Error('boom'));

    const result = repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
    });

    expect(result).toMatchObject({
      kind: 'requeued',
      job: { id: failed.id, status: 'pending' },
    });
    expect(repo.listJobs({ type: 'ingest', subjectId: 's1' }))
      .toHaveLength(401);
  });

  it('cancelled failed 最新任务新建 ingest', async () => {
    const { repo, context, params } = await setupAtomicReingest();
    const cancelled = repo.enqueueJob('ingest', {
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
    }, 's1');
    expect(repo.claimNextJob('ingest')?.id).toBe(cancelled.id);
    repo.failJob(cancelled.id, new Error('boom'));
    expect(repo.requestCancel(cancelled.id)).toBe('cancelled');
    expect(repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
    })).toMatchObject({ kind: 'created' });
    expect(repo.listJobs({ type: 'ingest', subjectId: 's1' })).toHaveLength(2);
  });

  it('completed 最新任务新建 ingest', async () => {
    const { repo, context, params } = await setupAtomicReingest();
    const completed = repo.enqueueJob('ingest', {
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
    }, 's1');
    expect(repo.claimNextJob('ingest')?.id).toBe(completed.id);
    repo.completeJob(completed.id, { ok: true });
    expect(repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
    })).toMatchObject({ kind: 'created' });
    expect(repo.listJobs({ type: 'ingest', subjectId: 's1' })).toHaveLength(2);
  });

  it('failed resultJson 损坏仍按普通失败原子重排', async () => {
    const { db, repo, context, params } = await setupAtomicReingest();
    const failed = repo.enqueueJob('ingest', {
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
    }, 's1');
    expect(repo.claimNextJob('ingest')?.id).toBe(failed.id);
    repo.failJob(failed.id, new Error('boom'));
    db.prepare(`UPDATE jobs SET result_json = ? WHERE id = ?`).run('{', failed.id);

    expect(repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
    })).toMatchObject({ kind: 'requeued', job: { id: failed.id } });
    expect(repo.getJobEvents(failed.id)).toHaveLength(1);
  });

  it('job:retrying 事件 INSERT 失败时整个 failed 重排回滚', async () => {
    const { db, repo, context, params, isDuplicateInFlight } = await setupAtomicReingest();
    const failed = repo.enqueueJob('ingest', {
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
    }, 's1');
    expect(repo.claimNextJob('ingest')?.id).toBe(failed.id);
    repo.failJob(failed.id, new Error('boom'));
    const before = repo.getJob(failed.id)!;
    db.exec(`
      CREATE TRIGGER fail_retry_event
      BEFORE INSERT ON job_events
      WHEN NEW.type = 'job:retrying'
      BEGIN
        SELECT RAISE(ABORT, 'event insert failed');
      END;
    `);

    expect(() => repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
      isDuplicateInFlight,
    })).toThrow(/event insert failed/);

    expect(repo.getJob(failed.id)).toMatchObject({
      status: 'failed',
      paramsJson: before.paramsJson,
      leaseExpiresAt: before.leaseExpiresAt,
      heartbeatAt: before.heartbeatAt,
    });
    expect(repo.getJobEvents(failed.id)).toEqual([]);
  });

  it('failed job 条件更新未命中时返回 conflict，且不修改或创建 job', async () => {
    const { db, repo, context, params } = await setupAtomicReingest();
    const failed = repo.enqueueJob('ingest', {
      sourceId: 'src-1',
      filename: 'source.md',
      subjectId: 's1',
    }, 's1');
    expect(repo.claimNextJob('ingest')?.id).toBe(failed.id);
    repo.failJob(failed.id, new Error('boom'));
    db.exec(`
      CREATE TRIGGER ignore_failed_requeue
      BEFORE UPDATE ON jobs
      WHEN OLD.id = '${failed.id}' AND NEW.status = 'pending'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    expect(repo.reingestSourceAtomic({
      subjectId: 's1',
      sourceId: 'src-1',
      createParams: params,
      paramsPatch: { remediationContext: context },
    })).toEqual({ kind: 'conflict' });
    expect(repo.getJob(failed.id)).toMatchObject({ status: 'failed' });
    expect(repo.listJobs({ type: 'ingest', subjectId: 's1' })).toHaveLength(1);
    expect(repo.getJobEvents(failed.id)).toEqual([]);
  });
});
