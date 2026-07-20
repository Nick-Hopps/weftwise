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

  it('取消提交后拒绝 worker 迟到写回 checkpoint', async () => {
    const { jobsRepo, checkpointsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', { f: 'x' }, null);
    jobsRepo.claimNextJob();

    expect(jobsRepo.requestCancel(job.id)).toBe('cancelled');

    // 模拟 worker 已越过上一次 cancelled() 检查，取消事务提交后才写入阶段结果。
    checkpointsRepo.putCheckpoint(job.id, 'plan', '', {
      plan: { pages: [{ slug: 'late-page' }] },
    });

    expect(checkpointsRepo.getCheckpoints(job.id)).toEqual([]);
    expect(checkpointsRepo.getProgress(job.id)).toBeNull();
  });

  it('历史遗留的 cancelled checkpoint 不再暴露为可续传进度', async () => {
    const { jobsRepo, checkpointsRepo } = await repos();
    const { getRawDb } = await import('../../client');
    const job = jobsRepo.enqueueJob('ingest', { f: 'x' }, null);
    jobsRepo.claimNextJob();
    expect(jobsRepo.requestCancel(job.id)).toBe('cancelled');

    // 直接构造旧版本竞态已经留下的脏数据，验证读取侧可以自我防御。
    getRawDb().prepare(`
      INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at)
      VALUES (?, 'plan', '', ?, ?)
    `).run(
      job.id,
      JSON.stringify({ plan: { pages: [{ slug: 'legacy-page' }] } }),
      new Date().toISOString(),
    );

    expect(checkpointsRepo.getCheckpoints(job.id)).toHaveLength(1);
    expect(checkpointsRepo.getProgress(job.id)).toBeNull();
  });

  it('取消 pending 任务：直接落 failed', async () => {
    const { jobsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', {}, null);
    expect(jobsRepo.requestCancel(job.id)).toBe('cancelled');
    expect(jobsRepo.getJob(job.id)!.status).toBe('failed');
  });

  it('终结已失败(failed)的 job：删检查点使其不可 resume + 标 cancelled + 保留原错误（status 仍 failed）', async () => {
    const { jobsRepo, checkpointsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', {}, null);
    jobsRepo.claimNextJob();
    jobsRepo.failJob(job.id, new Error('boom'));
    checkpointsRepo.putCheckpoint(job.id, 'writer-page', 'p1', { content: 'x' });
    expect(checkpointsRepo.getCheckpoints(job.id)).toHaveLength(1);

    const result = jobsRepo.requestCancel(job.id);

    expect(result).toBe('cancelled');
    const after = jobsRepo.getJob(job.id)!;
    expect(after.status).toBe('failed');
    const r = JSON.parse(after.resultJson!);
    expect(r.cancelled).toBe(true);
    expect(r.error.message).toBe('boom'); // 原错误保留供查阅
    expect(jobsRepo.isCancelRequested(job.id)).toBe(true);
    expect(checkpointsRepo.getCheckpoints(job.id)).toHaveLength(0); // 不可 resume
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

  it('重复取消已取消的任务 → already-terminal，不重复改写终态', async () => {
    const { jobsRepo } = await repos();
    const job = jobsRepo.enqueueJob('ingest', {}, null);

    expect(jobsRepo.requestCancel(job.id)).toBe('cancelled');
    const first = jobsRepo.getJob(job.id)!;
    expect(jobsRepo.requestCancel(job.id)).toBe('already-terminal');

    const second = jobsRepo.getJob(job.id)!;
    expect(second.status).toBe('failed');
    expect(second.resultJson).toBe(first.resultJson);
    expect(JSON.parse(second.resultJson!).cancelled).toBe(true);
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
