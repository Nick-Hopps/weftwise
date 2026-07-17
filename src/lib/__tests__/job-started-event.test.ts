import { describe, expect, it } from 'vitest';
import type { PendingActionView } from '../contracts';
import { isIngestJobStarted, jobStartedDetailForAction } from '../job-started-event';

function action(
  operation: PendingActionView['operation'],
  overrides: Partial<PendingActionView> = {},
): PendingActionView {
  return {
    actionId: 'action-1',
    conversationId: 'conversation-1',
    operation,
    status: 'applied',
    kind: 'workflow',
    preHead: 'head',
    summary: '研究主题 SQLite WAL',
    affectedPages: [],
    diff: null,
    warnings: [],
    expiresAt: '2026-07-16T00:00:00.000Z',
    operationId: null,
    jobId: 'job-1',
    error: null,
    ...overrides,
  };
}

describe('jobStartedDetailForAction', () => {
  it('re-enrich workflow 保留真实类型与页面 slug', () => {
    expect(jobStartedDetailForAction(action('workflow-reenrich-start', {
      affectedPages: [{ slug: 'normal-mapping', action: 'update' }],
    }))).toEqual({
      jobId: 'job-1',
      type: 're-enrich',
      label: 'normal-mapping',
      queueStatus: 'pending',
    });
  });

  it('research workflow 映射为 research，不伪装成 ingest', () => {
    expect(jobStartedDetailForAction(action('workflow-research-start'))).toEqual({
      jobId: 'job-1',
      type: 'research',
      label: '研究主题 SQLite WAL',
      queueStatus: 'pending',
    });
  });

  it('选区配图 workflow 映射为 image-insert 与目标页面 slug', () => {
    expect(jobStartedDetailForAction(action('workflow-image-insert-start', {
      affectedPages: [{ slug: 'page-a', action: 'update' }],
    }))).toEqual({
      jobId: 'job-1',
      type: 'image-insert',
      label: 'page-a',
      queueStatus: 'pending',
    });
  });

  it('取消、同步页面变更或无 jobId 时不广播新任务', () => {
    expect(jobStartedDetailForAction(action('workflow-cancel'))).toBeNull();
    expect(jobStartedDetailForAction(action('update', { kind: 'page-change' }))).toBeNull();
    expect(jobStartedDetailForAction(action('workflow-reenrich-start', { jobId: null }))).toBeNull();
  });
});

describe('isIngestJobStarted', () => {
  it('只有真实 ingest 事件能驱动顶部 ingest 胶囊', () => {
    expect(isIngestJobStarted({
      jobId: 'ingest-1',
      type: 'ingest',
      label: 'notes.md',
      queueStatus: 'pending',
    })).toBe(true);
    expect(isIngestJobStarted({
      jobId: 'reenrich-1',
      type: 're-enrich',
      label: 'normal-mapping',
      queueStatus: 'pending',
    })).toBe(false);
  });
});
