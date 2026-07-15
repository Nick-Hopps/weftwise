import { describe, expect, it } from 'vitest';
import { summarizeJobsPanel } from '../jobs-panel-state';

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
