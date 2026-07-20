import { describe, expect, it } from 'vitest';
import {
  isRecoverableUrlAuthJob,
  jobTypeVerb,
  recoverUnlistedTrackedJobs,
  shouldRefreshPageForCompletedJob,
  summarizeJobsPanel,
} from '../jobs-panel-state';

const jobs = [
  { id: 'running', queueStatus: 'running' as const },
  { id: 'pending', queueStatus: 'pending' as const },
  { id: 'completed', queueStatus: 'running' as const },
  { id: 'failed', queueStatus: 'running' as const },
];

describe('summarizeJobsPanel', () => {
  it('按 SSE 终态汇总可清理任务，不再把旧 queueStatus 计为运行中', () => {
    expect(summarizeJobsPanel(jobs, {
      running: 'streaming',
      pending: 'idle',
      completed: 'completed',
      failed: 'failed',
    })).toEqual({
      runningCount: 1,
      pendingCount: 1,
      completedCount: 1,
      failedCount: 1,
      finishedJobIds: ['completed', 'failed'],
      collapsedStatus: 'processing',
    });
  });

  it('全部成功时折叠态显示完成状态', () => {
    expect(summarizeJobsPanel(jobs.slice(0, 2), {
      running: 'completed',
      pending: 'completed',
    }).collapsedStatus).toBe('completed');
  });

  it('无活动任务且包含失败时折叠态显示失败状态', () => {
    expect(summarizeJobsPanel(jobs.slice(0, 2), {
      running: 'completed',
      pending: 'failed',
    }).collapsedStatus).toBe('failed');
  });
});

describe('recoverUnlistedTrackedJobs', () => {
  it('把未列出的 queued 行切换为 SSE 终态恢复', () => {
    const previous = [
      { id: 'running', type: 'ingest', label: 'a.md', subjectId: 's1', queueStatus: 'running' as const, reconnectKey: 0 },
      { id: 'fast-failure', type: 're-enrich', label: 'page-a', subjectId: 's1', queueStatus: 'pending' as const, reconnectKey: 0 },
      { id: 'still-active', type: 're-enrich', label: 'page-b', subjectId: 's1', queueStatus: 'pending' as const, reconnectKey: 0 },
      { id: 'dismissed', type: 're-enrich', label: 'page-c', subjectId: 's1', queueStatus: 'pending' as const, reconnectKey: 0 },
    ];

    expect(recoverUnlistedTrackedJobs(
      previous,
      new Set(['still-active']),
      new Set(['dismissed']),
    )).toEqual([
      previous[0],
      { ...previous[1], queueStatus: 'running' },
    ]);
  });
});

describe('isRecoverableUrlAuthJob', () => {
  it('只恢复 failed ingest 的结构化 url-auth-required 结果', () => {
    const authFailure = JSON.stringify({ error: { code: 'url-auth-required' } });
    expect(isRecoverableUrlAuthJob({
      type: 'ingest', status: 'failed', resultJson: authFailure,
    })).toBe(true);
    expect(isRecoverableUrlAuthJob({
      type: 'research', status: 'failed', resultJson: authFailure,
    })).toBe(false);
    expect(isRecoverableUrlAuthJob({
      type: 'ingest', status: 'completed', resultJson: authFailure,
    })).toBe(false);
    expect(isRecoverableUrlAuthJob({
      type: 'ingest', status: 'failed', resultJson: JSON.stringify({ error: { message: '401' } }),
    })).toBe(false);
  });
});

describe('image-insert presentation', () => {
  it('Tasks 使用 Illustrating，并只在该 job 成功完成时刷新页面', () => {
    expect(jobTypeVerb('image-insert')).toBe('jobs.activity.imageInsert');
    expect(shouldRefreshPageForCompletedJob('image-insert', 'completed')).toBe(true);
    expect(shouldRefreshPageForCompletedJob('image-insert', 'failed')).toBe(false);
    expect(shouldRefreshPageForCompletedJob('research', 'completed')).toBe(false);
  });
});
