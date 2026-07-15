import { describe, expect, it } from 'vitest';
import type { Job } from '@/lib/contracts';
import {
  ingestTaskFromJob,
  mergeIngestTasks,
  pickInitialIngestTaskId,
} from '../ingest-task-list';

function job(overrides: Partial<Job> & Pick<Job, 'id' | 'status'>): Job {
  const { id, status, ...rest } = overrides;
  return {
    id,
    type: 'ingest',
    status,
    paramsJson: JSON.stringify({ filename: `${id}.md` }),
    resultJson: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    subjectId: 'subject-1',
    ...rest,
  };
}

describe('ingestTaskFromJob', () => {
  it('从 paramsJson 提取文件名并保留检查点', () => {
    expect(
      ingestTaskFromJob({
        ...job({ id: 'job-1', status: 'failed' }),
        paramsJson: JSON.stringify({ filename: 'notes.md' }),
        checkpointProgress: { plan: true, chunkSummaries: 3, writerPages: 2, totalPages: 5 },
      }),
    ).toMatchObject({
      id: 'job-1',
      sourceName: 'notes.md',
      queueStatus: 'failed',
      checkpointProgress: { plan: true, chunkSummaries: 3, writerPages: 2, totalPages: 5 },
    });
  });

  it('损坏或缺少 paramsJson 时使用稳定兜底名称', () => {
    expect(
      ingestTaskFromJob({ ...job({ id: 'abcdefgh-1234', status: 'running' }), paramsJson: '{' })
        .sourceName,
    ).toBe('Ingest abcdefgh');
  });
});

describe('mergeIngestTasks', () => {
  it('按 ID 去重、更新状态，并保持创建时间顺序', () => {
    const pending = ingestTaskFromJob(job({
      id: 'job-b',
      status: 'pending',
      createdAt: '2026-07-15T00:00:02.000Z',
    }));
    const first = ingestTaskFromJob(job({
      id: 'job-a',
      status: 'running',
      createdAt: '2026-07-15T00:00:01.000Z',
    }));
    const running = { ...pending, queueStatus: 'running' as const };

    expect(mergeIngestTasks([pending], [first, running])).toEqual([first, running]);
  });
});

describe('pickInitialIngestTaskId', () => {
  it('依次优先最新 running、pending、failed', () => {
    const failed = ingestTaskFromJob(job({ id: 'failed', status: 'failed' }));
    const pending = ingestTaskFromJob(job({ id: 'pending', status: 'pending' }));
    const runningOld = ingestTaskFromJob(job({
      id: 'running-old',
      status: 'running',
      createdAt: '2026-07-15T00:00:01.000Z',
    }));
    const runningNew = ingestTaskFromJob(job({
      id: 'running-new',
      status: 'running',
      createdAt: '2026-07-15T00:00:03.000Z',
    }));

    expect(pickInitialIngestTaskId([failed, pending, runningOld, runningNew])).toBe('running-new');
    expect(pickInitialIngestTaskId([failed, pending])).toBe('pending');
    expect(pickInitialIngestTaskId([failed])).toBe('failed');
  });
});
