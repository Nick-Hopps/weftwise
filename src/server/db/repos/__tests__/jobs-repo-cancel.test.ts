import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobs-cancel-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function repos() {
  await import('../../client'); // 触发 ensureTables（含 cancel_requested 列）
  const jobsRepo = await import('../jobs-repo');
  const checkpointsRepo = await import('../checkpoints-repo');
  return { jobsRepo, checkpointsRepo };
}

describe('jobs-repo.requestCancel / isCancelRequested', () => {
  it('取消 running 任务：落终态 failed + 置 cancel 标记 + 清租约/心跳 + 删检查点 + result 标 cancelled', async () => {
    const { jobsRepo, checkpointsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', { f: 'x' }, null);
    jobsRepo.claimNextJob(); // pending → running，写 lease/heartbeat
    checkpointsRepo.putCheckpoint(job.id, 'chunk-summary', 'c1', { s: 1 });
    expect(checkpointsRepo.getCheckpoints(job.id)).toHaveLength(1);

    const result = jobsRepo.requestCancel(job.id);

    expect(result).toBe('cancelled');
    const after = jobsRepo.getJob(job.id)!;
    expect(after.status).toBe('failed');
    expect(after.leaseExpiresAt).toBeNull();
    expect(after.heartbeatAt).toBeNull();
    expect(jobsRepo.isCancelRequested(job.id)).toBe(true);
    expect(JSON.parse(after.resultJson!).cancelled).toBe(true);
    expect(checkpointsRepo.getCheckpoints(job.id)).toHaveLength(0);
  });

  it('取消 pending 任务：直接落 failed', async () => {
    const { jobsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', {}, null);
    expect(jobsRepo.requestCancel(job.id)).toBe('cancelled');
    expect(jobsRepo.getJob(job.id)!.status).toBe('failed');
  });

  it('已终态(completed) → already-terminal，不覆盖原结果', async () => {
    const { jobsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', {}, null);
    jobsRepo.completeJob(job.id, { ok: true });
    expect(jobsRepo.requestCancel(job.id)).toBe('already-terminal');
    const after = jobsRepo.getJob(job.id)!;
    expect(after.status).toBe('completed');
    expect(JSON.parse(after.resultJson!).ok).toBe(true);
  });

  it('不存在的 job → not-found', async () => {
    const { jobsRepo } = await repos();
    expect(jobsRepo.requestCancel('does-not-exist')).toBe('not-found');
  });

  it('isCancelRequested 默认 false', async () => {
    const { jobsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', {}, null);
    expect(jobsRepo.isCancelRequested(job.id)).toBe(false);
  });

  it('requeue 清除 cancel 标记（手动重试从干净状态起，不会一启动就自取消）', async () => {
    const { jobsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', {}, null);
    jobsRepo.claimNextJob();
    jobsRepo.requestCancel(job.id);
    expect(jobsRepo.isCancelRequested(job.id)).toBe(true);

    jobsRepo.requeueJob(job.id);
    expect(jobsRepo.getJob(job.id)!.status).toBe('pending');
    expect(jobsRepo.isCancelRequested(job.id)).toBe(false);
  });
});
