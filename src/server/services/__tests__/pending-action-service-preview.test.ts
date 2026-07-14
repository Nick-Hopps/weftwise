import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingActionPreview, Subject } from '@/lib/contracts';
import type { PendingActionRecord } from '../../db/repos/pending-actions-repo';

const conversationMocks = vi.hoisted(() => ({ getConversation: vi.fn() }));
vi.mock('../../db/repos/conversations-repo', () => conversationMocks);

const repoMocks = vi.hoisted(() => ({
  createPendingAction: vi.fn(),
  expirePending: vi.fn(() => 0),
  listForConversation: vi.fn((): PendingActionRecord[] => []),
}));
vi.mock('../../db/repos/pending-actions-repo', () => repoMocks);

const pagePlanMocks = vi.hoisted(() => ({
  planCreatePageInSubject: vi.fn(),
  planUpdatePageInSubject: vi.fn(),
  planPatchPageInSubject: vi.fn(),
  planDeletePageInSubject: vi.fn(),
  planMetadataPatchInSubject: vi.fn(),
  planLinkEnsureInSubject: vi.fn(),
  planMovePageInSubject: vi.fn(),
}));
vi.mock('../page-write', () => pagePlanMocks);

const reenrichMocks = vi.hoisted(() => ({ planReenrich: vi.fn() }));
vi.mock('../reenrich-enqueue', () => reenrichMocks);
const workflowMocks = vi.hoisted(() => ({
  planWorkflowReenrich: vi.fn(),
  planWorkflowResearch: vi.fn(),
  planWorkflowCancel: vi.fn(),
}));
vi.mock('../workflow-tools', () => workflowMocks);
const operationPlanMocks = vi.hoisted(() => ({
  applyPlannedPageOperation: vi.fn(),
}));
vi.mock('../../wiki/page-operation-plan', () => operationPlanMocks);
const historyMocks = vi.hoisted(() => ({
  planHistoryRevert: vi.fn(),
  applyPlannedHistoryRevert: vi.fn(),
}));
vi.mock('../history-tools', () => historyMocks);
const embeddingMocks = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('../embedding-service', () => embeddingMocks);

import {
  PendingActionError,
  createPendingActionPreview,
  createPendingHistoryRevertPreview,
  createPendingWorkflowActionPreview,
  listPendingActions,
} from '../pending-action-service';

const subject: Subject = {
  id: 's1', slug: 'general', name: 'General', description: '', augmentationLevel: 'standard',
  createdAt: '', updatedAt: '',
};
const now = new Date('2026-07-11T00:00:00.000Z');
const pagePreview: PendingActionPreview = {
  kind: 'page-change', preHead: 'head-1', summary: '删除 page-a',
  affectedPages: [{ slug: 'page-a', action: 'delete' }], diff: 'page diff', warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  conversationMocks.getConversation.mockReturnValue({ id: 'c1', subjectId: 's1' });
  pagePlanMocks.planDeletePageInSubject.mockResolvedValue({
    ...pagePreview,
    operation: 'delete',
    changeset: { id: 'cs-1' },
    resultHint: { deletedSlug: 'page-a', brokenBacklinks: 0 },
  });
  pagePlanMocks.planMetadataPatchInSubject.mockResolvedValue({
    ...pagePreview,
    operation: 'metadata-patch',
    changeset: { id: 'cs-metadata' },
    resultHint: { updatedSlug: 'page-a', referencesUpdated: 0, changedFields: ['summary'] },
  });
  pagePlanMocks.planLinkEnsureInSubject.mockResolvedValue({
    ...pagePreview,
    operation: 'link-ensure',
    changeset: { id: 'cs-link' },
    resultHint: {
      updatedSlug: 'page-a', mode: 'link', targetSubjectSlug: 'general', targetSlug: 'page-b',
    },
  });
  pagePlanMocks.planMovePageInSubject.mockResolvedValue({
    ...pagePreview,
    summary: '移动页面 page-a → page-b',
    operation: 'move',
    changeset: { id: 'cs-move' },
    affectedPages: [
      { slug: 'page-b', action: 'create' },
      { slug: 'page-a', action: 'delete' },
    ],
    resultHint: {
      movedFromSlug: 'page-a', movedToSlug: 'page-b',
      referencesUpdated: 0, sourceLinksMigrated: 0,
    },
  });
  historyMocks.planHistoryRevert.mockResolvedValue({
    originalOperationId: 'op-old', preHead: 'head-1', changeset: { id: 'cs-history' },
    summary: '回滚历史操作 op-old', affectedPages: pagePreview.affectedPages,
    diff: 'history diff', warnings: ['会覆盖后续修改'],
  });
  workflowMocks.planWorkflowReenrich.mockResolvedValue({
    kind: 'workflow', preHead: 'head-1', summary: '重新丰富 page-a',
    affectedPages: [{ slug: 'page-a', action: 'update' }], diff: null, warnings: [],
  });
  workflowMocks.planWorkflowResearch.mockResolvedValue({
    kind: 'workflow', preHead: 'head-1', summary: '研究主题 SQLite',
    affectedPages: [], diff: null, warnings: ['候选仍需批准'],
  });
  workflowMocks.planWorkflowCancel.mockResolvedValue({
    kind: 'workflow', preHead: 'head-1', summary: '取消 research 任务 job-1',
    affectedPages: [], diff: null, warnings: ['任务会终止'],
  });
  repoMocks.createPendingAction.mockImplementation((input: Record<string, unknown>) => ({
    ...input,
    id: 'a1',
    status: 'pending',
    approvedAt: null,
    appliedAt: null,
    operationId: null,
    jobId: null,
    errorJson: null,
  }));
});

describe('createPendingActionPreview', () => {
  it('move 只保存预览，批准前不执行页面迁移', async () => {
    const view = await createPendingActionPreview({
      conversationId: 'c1', subject,
      input: { operation: 'move', payload: { slug: 'page-a', newSlug: 'page-b' } },
      now,
    });
    expect(pagePlanMocks.planMovePageInSubject).toHaveBeenCalledWith(
      subject,
      { slug: 'page-a', newSlug: 'page-b' },
      now.toISOString(),
    );
    expect(repoMocks.createPendingAction).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'move',
      payloadJson: JSON.stringify({
        effectiveAt: now.toISOString(), newSlug: 'page-b', slug: 'page-a',
      }),
    }));
    expect(view.operation).toBe('move');
    expect(operationPlanMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
  });

  it('页面操作保存规范化 payload、hash、预览与 30 分钟有效期', async () => {
    const view = await createPendingActionPreview({
      conversationId: 'c1',
      subject,
      input: { operation: 'delete', payload: { slug: ' page-a ' } },
      now,
    });

    expect(pagePlanMocks.planDeletePageInSubject)
      .toHaveBeenCalledWith(subject, 'page-a', '2026-07-11T00:00:00.000Z');
    expect(repoMocks.createPendingAction).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'c1',
      subjectId: 's1',
      operation: 'delete',
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: '2026-07-11T00:30:00.000Z',
    }));
    expect(view).toMatchObject({
      actionId: 'a1', conversationId: 'c1', operation: 'delete', status: 'pending',
      preHead: 'head-1', diff: 'page diff', expiresAt: '2026-07-11T00:30:00.000Z',
    });
  });

  it('reenrich 保存 workflow preview，预览阶段不入队', async () => {
    reenrichMocks.planReenrich.mockResolvedValue({
      kind: 'workflow', preHead: 'head-1', summary: '重新丰富 page-a',
      affectedPages: [{ slug: 'page-a', action: 'update' }], diff: null,
      warnings: ['批准的是重新丰富任务，不是确定的内容变更。'],
    });

    const view = await createPendingActionPreview({
      conversationId: 'c1', subject,
      input: { operation: 'reenrich', payload: { slug: 'page-a' } }, now,
    });

    expect(reenrichMocks.planReenrich).toHaveBeenCalledWith('s1', 'page-a');
    expect(view).toMatchObject({ kind: 'workflow', diff: null, operation: 'reenrich' });
  });

  it('history revert 保存独立 operation payload，预览阶段零写入', async () => {
    const view = await createPendingHistoryRevertPreview({
      conversationId: 'c1', subject, operationId: ' op-old ', now,
    });

    expect(historyMocks.planHistoryRevert).toHaveBeenCalledWith(subject, 'op-old');
    expect(repoMocks.createPendingAction).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'history-revert',
      payloadJson: JSON.stringify({
        effectiveAt: now.toISOString(),
        operationId: 'op-old',
      }),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(view).toMatchObject({
      operation: 'history-revert', kind: 'page-change', diff: 'history diff', status: 'pending',
    });
    expect(historyMocks.applyPlannedHistoryRevert).not.toHaveBeenCalled();
  });

  it.each([
    ['workflow-reenrich-start', { slug: ' page-a ' }, 'planWorkflowReenrich', 'page-a'],
    ['workflow-research-start', { topic: ' SQLite ' }, 'planWorkflowResearch', 'SQLite'],
    ['workflow-cancel', { jobId: ' job-1 ' }, 'planWorkflowCancel', 'job-1'],
  ] as const)('%s 保存规范化 workflow payload，预览阶段零 job 副作用', async (
    operation,
    actionPayload,
    planner,
    expected,
  ) => {
    const view = await createPendingWorkflowActionPreview({
      conversationId: 'c1',
      subject,
      input: { operation, payload: actionPayload } as never,
      now,
    });

    expect(workflowMocks[planner]).toHaveBeenCalledWith(subject, expected);
    expect(repoMocks.createPendingAction).toHaveBeenCalledWith(expect.objectContaining({
      operation,
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(view).toMatchObject({ operation, kind: 'workflow', status: 'pending' });
  });

  it('metadata/link 预览复用共享 planner，绝不 apply 或触发 embedding', async () => {
    const metadata = await createPendingActionPreview({
      conversationId: 'c1', subject, now,
      input: {
        operation: 'metadata-patch',
        payload: { slug: ' page-a ', summary: ' 新摘要 ' },
      },
    });
    const link = await createPendingActionPreview({
      conversationId: 'c1', subject, now,
      input: {
        operation: 'link-ensure',
        payload: {
          sourceSlug: ' page-a ', targetSlug: ' page-b ', oldString: 'Page B', mode: 'link',
        },
      },
    });

    expect(pagePlanMocks.planMetadataPatchInSubject).toHaveBeenCalledWith(
      subject,
      { slug: 'page-a', summary: '新摘要' },
      now.toISOString(),
    );
    expect(pagePlanMocks.planLinkEnsureInSubject).toHaveBeenCalledWith(
      subject,
      {
        sourceSlug: 'page-a', targetSlug: 'page-b', oldString: 'Page B', mode: 'link',
      },
      now.toISOString(),
    );
    expect(metadata).toMatchObject({ operation: 'metadata-patch', kind: 'page-change' });
    expect(link).toMatchObject({ operation: 'link-ensure', kind: 'page-change' });
    expect(operationPlanMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
    expect(embeddingMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it.each([
    ['metadata-patch', { slug: 'index', summary: 'x' }, 'planMetadataPatchInSubject'],
    ['link-ensure', {
      sourceSlug: 'log', targetSlug: 'page-b', oldString: 'Page B', mode: 'link',
    }, 'planLinkEnsureInSubject'],
  ] as const)('%s 系统页预览由 page-write 保护层拒绝，且不落库', async (
    operation,
    actionPayload,
    plannerName,
  ) => {
    pagePlanMocks[plannerName].mockRejectedValueOnce(new Error('protected system page'));

    await expect(createPendingActionPreview({
      conversationId: 'c1', subject, now,
      input: { operation, payload: actionPayload } as never,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_INVALID' });

    expect(pagePlanMocks[plannerName]).toHaveBeenCalledOnce();
    expect(repoMocks.createPendingAction).not.toHaveBeenCalled();
    expect(operationPlanMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
    expect(embeddingMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('metadata path traversal 规划失败时返回 ACTION_PLAN_INVALID 且无副作用', async () => {
    pagePlanMocks.planMetadataPatchInSubject.mockRejectedValueOnce(
      new Error('slug must be a non-empty canonical page slug'),
    );

    await expect(createPendingActionPreview({
      conversationId: 'c1', subject, now,
      input: {
        operation: 'metadata-patch',
        payload: { slug: '../other/page', summary: '越界' },
      },
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_INVALID' });

    expect(pagePlanMocks.planMetadataPatchInSubject).toHaveBeenCalledWith(
      subject,
      { slug: '../other/page', summary: '越界' },
      now.toISOString(),
    );
    expect(repoMocks.createPendingAction).not.toHaveBeenCalled();
    expect(operationPlanMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
    expect(embeddingMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('跨 Subject conversation 与 planner 失败均不落库', async () => {
    conversationMocks.getConversation.mockReturnValueOnce({ id: 'c1', subjectId: 's2' });
    await expect(createPendingActionPreview({
      conversationId: 'c1', subject,
      input: { operation: 'delete', payload: { slug: 'page-a' } }, now,
    })).rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' });

    conversationMocks.getConversation.mockReturnValueOnce({ id: 'c1', subjectId: 's1' });
    pagePlanMocks.planDeletePageInSubject.mockRejectedValueOnce(new Error('protected page'));
    await expect(createPendingActionPreview({
      conversationId: 'c1', subject,
      input: { operation: 'delete', payload: { slug: 'index' } }, now,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_INVALID' });
    expect(repoMocks.createPendingAction).not.toHaveBeenCalled();
  });
});

describe('listPendingActions', () => {
  it('先惰性过期，再返回当前 conversation 的 view', () => {
    repoMocks.listForConversation.mockReturnValue([{ 
      id: 'a1', conversationId: 'c1', subjectId: 's1', operation: 'delete',
      payloadJson: '{}', payloadHash: 'h', previewJson: JSON.stringify(pagePreview),
      status: 'pending', createdAt: now.toISOString(), updatedAt: now.toISOString(),
      expiresAt: '2026-07-11T00:30:00.000Z', approvedAt: null, appliedAt: null,
      operationId: null, jobId: null, errorJson: null,
    }]);
    const result = listPendingActions({ conversationId: 'c1', subject, now });
    expect(repoMocks.expirePending).toHaveBeenCalledWith(now.toISOString());
    expect(result[0]).toMatchObject({ actionId: 'a1', summary: '删除 page-a' });
  });

  it('导出稳定错误类型', () => {
    expect(new PendingActionError('ACTION_NOT_FOUND', 'missing', 404))
      .toMatchObject({ code: 'ACTION_NOT_FOUND', httpStatus: 404 });
  });
});
