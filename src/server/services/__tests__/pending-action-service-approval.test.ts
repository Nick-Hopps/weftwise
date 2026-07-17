import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingActionPreview, Subject } from '@/lib/contracts';
import type { PendingActionRecord } from '../../db/repos/pending-actions-repo';
import { canonicalJson, hashPendingActionPayload } from '../pending-action-payload';

const conversationMocks = vi.hoisted(() => ({ getConversation: vi.fn() }));
vi.mock('../../db/repos/conversations-repo', () => conversationMocks);
const repoMocks = vi.hoisted(() => ({
  getScoped: vi.fn(), claimApproval: vi.fn(), claimExecution: vi.fn(), refreshPreview: vi.fn(),
  refreshExecutingPreview: vi.fn(),
  markApplied: vi.fn(), markFailed: vi.fn(), rejectPending: vi.fn(), expirePending: vi.fn(() => 0),
  listRecoverable: vi.fn((): PendingActionRecord[] => []), pruneTerminal: vi.fn(() => 0),
}));
vi.mock('../../db/repos/pending-actions-repo', () => repoMocks);
const pageMocks = vi.hoisted(() => ({
  planDeletePageInSubject: vi.fn(), planCreatePageInSubject: vi.fn(),
  planUpdatePageInSubject: vi.fn(), planPatchPageInSubject: vi.fn(),
  planMetadataPatchInSubject: vi.fn(), planLinkEnsureInSubject: vi.fn(),
  planMovePageInSubject: vi.fn(),
  planTagBatchInSubject: vi.fn(),
}));
vi.mock('../page-write', () => pageMocks);
const applyMocks = vi.hoisted(() => ({
  applyPlannedPageOperation: vi.fn(),
}));
vi.mock('../../wiki/page-operation-plan', () => applyMocks);
const historyMocks = vi.hoisted(() => ({
  planHistoryRevert: vi.fn(),
  applyPlannedHistoryRevert: vi.fn(),
}));
vi.mock('../history-tools', () => historyMocks);
const reenrichMocks = vi.hoisted(() => ({ planReenrich: vi.fn(), enqueueReenrich: vi.fn() }));
vi.mock('../reenrich-enqueue', () => reenrichMocks);
const workflowMocks = vi.hoisted(() => ({
  planWorkflowReenrich: vi.fn(),
  planWorkflowResearch: vi.fn(),
  planWorkflowCancel: vi.fn(),
  planWorkflowImageInsert: vi.fn(),
  reportWorkflowCancellation: vi.fn(),
}));
vi.mock('../workflow-tools', () => workflowMocks);
const operationMocks = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock('../../db/repos/operations-repo', () => operationMocks);
const finalizerMocks = vi.hoisted(() => ({
  finalizeAppliedPageAction: vi.fn(),
  finalizeAppliedHistoryRevertAction: vi.fn(),
  finalizeWorkflowStartAction: vi.fn(),
  finalizeWorkflowCancelAction: vi.fn(),
}));
vi.mock('../pending-action-finalizer', () => finalizerMocks);

import {
  approvePendingAction, maintainPendingActions, rejectPendingAction, recoverPendingActions,
} from '../pending-action-service';

const subject: Subject = { id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard', createdAt: '', updatedAt: '' };
const now = new Date('2026-07-11T00:10:00.000Z');
const payload = { slug: 'page-a', effectiveAt: '2026-07-11T00:00:00.000Z' };
const preview: PendingActionPreview = { kind: 'page-change', preHead: 'head-1',
  summary: '删除 page-a', affectedPages: [{ slug: 'page-a', action: 'delete' }],
  diff: 'diff-1', warnings: [] };

function record(status = 'pending', overrides: Record<string, unknown> = {}): PendingActionRecord {
  return {
    id: 'a1', conversationId: 'c1', subjectId: 's1', operation: 'delete',
    payloadJson: canonicalJson(payload),
    payloadHash: hashPendingActionPayload({ conversationId: 'c1', subjectId: 's1',
      operation: 'delete', payload }),
    previewJson: JSON.stringify(preview), status,
    createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z',
    expiresAt: '2026-07-11T00:30:00.000Z', approvedAt: null, appliedAt: null,
    operationId: null, jobId: null, errorJson: null, ...overrides,
  } as PendingActionRecord;
}

const pagePlan = { operation: 'delete', preHead: 'head-1', changeset: { id: 'op-1' },
  summary: preview.summary, affectedPages: preview.affectedPages, diff: preview.diff,
  warnings: [], resultHint: { deletedSlug: 'page-a', brokenBacklinks: 0 } };

beforeEach(() => {
  vi.resetAllMocks();
  conversationMocks.getConversation.mockReturnValue({ id: 'c1', subjectId: 's1' });
  repoMocks.getScoped.mockReturnValue(record());
  repoMocks.claimApproval.mockReturnValue(record('approved', { approvedAt: now.toISOString() }));
  repoMocks.claimExecution.mockReturnValue(true);
  repoMocks.markApplied.mockReturnValue(true);
  repoMocks.rejectPending.mockReturnValue(true);
  repoMocks.refreshPreview.mockReturnValue(true);
  repoMocks.refreshExecutingPreview.mockReturnValue(true);
  repoMocks.listRecoverable.mockReturnValue([]);
  repoMocks.pruneTerminal.mockReturnValue(0);
  repoMocks.expirePending.mockReturnValue(0);
  pageMocks.planDeletePageInSubject.mockResolvedValue(pagePlan);
  pageMocks.planMetadataPatchInSubject.mockResolvedValue({ ...pagePlan, operation: 'metadata-patch' });
  pageMocks.planLinkEnsureInSubject.mockResolvedValue({ ...pagePlan, operation: 'link-ensure' });
  pageMocks.planMovePageInSubject.mockResolvedValue({ ...pagePlan, operation: 'move' });
  pageMocks.planTagBatchInSubject.mockResolvedValue({ ...pagePlan, operation: 'tag-batch' });
  applyMocks.applyPlannedPageOperation.mockResolvedValue({ operationId: 'op-1' });
  historyMocks.planHistoryRevert.mockResolvedValue({
    originalOperationId: 'op-old', preHead: 'head-1', changeset: { id: 'op-revert' },
    summary: '回滚历史操作 op-old', affectedPages: preview.affectedPages,
    diff: 'history diff', warnings: ['会覆盖后续修改'],
  });
  historyMocks.applyPlannedHistoryRevert.mockResolvedValue({
    originalOperationId: 'op-old', operationId: 'op-revert',
    newCommitSha: 'head-2', affectedSlugs: ['page-a'],
  });
  workflowMocks.planWorkflowReenrich.mockResolvedValue({ ...preview, kind: 'workflow', diff: null });
  workflowMocks.planWorkflowResearch.mockResolvedValue({
    ...preview, kind: 'workflow', summary: '研究主题 SQLite', affectedPages: [], diff: null,
  });
  workflowMocks.planWorkflowCancel.mockResolvedValue({
    ...preview, kind: 'workflow', summary: '取消 research 任务 job-1', affectedPages: [], diff: null,
  });
  workflowMocks.planWorkflowImageInsert.mockResolvedValue({
    ...preview,
    kind: 'workflow',
    summary: '为 page-a 生成选区配图',
    diff: null,
    imageInsert: {
      selection: 'Selected paragraph.',
      prompt: 'Explain visually',
      alt: 'Explanation diagram',
    },
  });
  finalizerMocks.finalizeWorkflowStartAction.mockReturnValue({ id: 'job-1' });
  finalizerMocks.finalizeWorkflowCancelAction.mockReturnValue({ id: 'job-1' });
});

describe('approvePendingAction', () => {
  it('页面 action 重新规划、抢占执行并标 applied', async () => {
    repoMocks.getScoped
      .mockReturnValueOnce(record())
      .mockReturnValueOnce(record('applied', { operationId: 'op-1', appliedAt: now.toISOString() }));
    const result = await approvePendingAction({ id: 'a1', subject, now });
    expect(pageMocks.planDeletePageInSubject).toHaveBeenCalledWith(
      subject, 'page-a', payload.effectiveAt,
    );
    expect(repoMocks.claimExecution).toHaveBeenCalledWith(
      'a1', 's1', 'op-1', null, now.toISOString(),
    );
    expect(applyMocks.applyPlannedPageOperation).toHaveBeenCalledWith(pagePlan);
    expect(finalizerMocks.finalizeAppliedPageAction).toHaveBeenCalledOnce();
    expect(finalizerMocks.finalizeAppliedPageAction).toHaveBeenCalledWith({
      actionId: 'a1', subjectId: 's1', nowIso: now.toISOString(),
    });
    expect(repoMocks.markApplied).not.toHaveBeenCalled();
    expect(result.status).toBe('applied');
  });

  it('无 conversation 的 tag-batch 仍校验 hash、重规划并走同一 apply/finalize', async () => {
    const tagPayload = {
      action: 'merge', sourceTag: 'old', targetTag: 'canonical',
      effectiveAt: '2026-07-11T00:00:00.000Z',
    };
    const tagRecord = record('pending', {
      conversationId: null,
      operation: 'tag-batch',
      payloadJson: canonicalJson(tagPayload),
      payloadHash: hashPendingActionPayload({
        conversationId: null, subjectId: 's1', operation: 'tag-batch', payload: tagPayload,
      }),
    });
    repoMocks.getScoped
      .mockReturnValueOnce(tagRecord)
      .mockReturnValueOnce({ ...tagRecord, status: 'applied', operationId: 'op-1' });
    repoMocks.claimApproval.mockReturnValue({ ...tagRecord, status: 'approved' });

    const result = await approvePendingAction({ id: 'a1', subject, now });

    expect(pageMocks.planTagBatchInSubject).toHaveBeenCalledWith(
      subject,
      { action: 'merge', sourceTag: 'old', targetTag: 'canonical' },
      tagPayload.effectiveAt,
    );
    expect(applyMocks.applyPlannedPageOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'tag-batch' }),
    );
    expect(finalizerMocks.finalizeAppliedPageAction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ operation: 'tag-batch', status: 'applied' });
  });

  it('HEAD 变化时刷新预览并要求重新批准', async () => {
    pageMocks.planDeletePageInSubject.mockResolvedValueOnce({
      ...pagePlan, preHead: 'head-2', diff: 'diff-2',
    });
    repoMocks.getScoped.mockReturnValueOnce(record()).mockReturnValueOnce(record());
    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_STALE_PREVIEW', httpStatus: 409 });
    expect(repoMocks.refreshPreview).toHaveBeenCalled();
    expect(applyMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it('拿到 vault 锁前 HEAD 变化时从 executing 受限退回 pending', async () => {
    const refreshedPlan = { ...pagePlan, preHead: 'head-2', diff: 'diff-2' };
    const refreshedPreview: PendingActionPreview = {
      kind: 'page-change',
      preHead: 'head-2',
      summary: refreshedPlan.summary,
      affectedPages: refreshedPlan.affectedPages,
      diff: 'diff-2',
      warnings: refreshedPlan.warnings,
    };
    pageMocks.planDeletePageInSubject
      .mockResolvedValueOnce(pagePlan)
      .mockResolvedValueOnce(refreshedPlan);
    applyMocks.applyPlannedPageOperation.mockRejectedValueOnce(Object.assign(
      new Error('Vault HEAD changed after preview.'),
      { code: 'ACTION_STALE_PREVIEW', expectedHead: 'head-1', actualHead: 'head-2' },
    ));
    repoMocks.getScoped
      .mockReturnValueOnce(record())
      .mockReturnValueOnce(record('pending', {
        previewJson: JSON.stringify(refreshedPreview),
      }));

    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({
        code: 'ACTION_STALE_PREVIEW',
        httpStatus: 409,
        action: { status: 'pending', preHead: 'head-2' },
      });

    expect(pageMocks.planDeletePageInSubject).toHaveBeenCalledTimes(2);
    expect(repoMocks.refreshExecutingPreview).toHaveBeenCalledWith({
      id: 'a1',
      subjectId: 's1',
      operationId: 'op-1',
      payloadHash: expect.any(String),
      previewJson: JSON.stringify(refreshedPreview),
      expiresAt: '2026-07-11T00:40:00.000Z',
      updatedAt: now.toISOString(),
    });
    expect(repoMocks.markFailed).not.toHaveBeenCalled();
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it('payload hash 不匹配时不规划不执行', async () => {
    repoMocks.getScoped.mockReturnValue(record('pending', { payloadHash: 'tampered' }));
    repoMocks.claimApproval.mockReturnValue(record('approved', { payloadHash: 'tampered' }));
    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_PAYLOAD_MISMATCH' });
    expect(pageMocks.planDeletePageInSubject).not.toHaveBeenCalled();
    expect(applyMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it('旧 reenrich action 通过新原子 finalizer 入队并保存 jobId', async () => {
    const workflow = { ...preview, kind: 'workflow', diff: null };
    const reenrichPayload = { slug: 'page-a', effectiveAt: payload.effectiveAt };
    const pending = record('pending', {
      operation: 'reenrich', payloadJson: canonicalJson(reenrichPayload),
      payloadHash: hashPendingActionPayload({ conversationId: 'c1', subjectId: 's1',
        operation: 'reenrich', payload: reenrichPayload }), previewJson: JSON.stringify(workflow),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce({
      ...pending, status: 'applied', jobId: 'job-1', appliedAt: now.toISOString(),
    });
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    reenrichMocks.planReenrich.mockResolvedValue(workflow);
    const result = await approvePendingAction({ id: 'a1', subject, now });
    expect(repoMocks.claimExecution).toHaveBeenCalledWith('a1', 's1', null, null, now.toISOString());
    expect(finalizerMocks.finalizeWorkflowStartAction).toHaveBeenCalledWith({
      actionId: 'a1', subjectId: 's1', type: 're-enrich',
      params: { slug: 'page-a', subjectId: 's1' }, nowIso: now.toISOString(),
    });
    expect(repoMocks.markApplied).not.toHaveBeenCalled();
    expect(result.jobId).toBe('job-1');
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it('workflow research fresh 批准后原子入队，不直接导入候选', async () => {
    const workflowPayload = { topic: 'SQLite', effectiveAt: payload.effectiveAt };
    const workflowPreview = {
      ...preview, kind: 'workflow' as const, summary: '研究主题 SQLite',
      affectedPages: [], diff: null,
    };
    const pending = record('pending', {
      operation: 'workflow-research-start', payloadJson: canonicalJson(workflowPayload),
      payloadHash: hashPendingActionPayload({ conversationId: 'c1', subjectId: 's1',
        operation: 'workflow-research-start', payload: workflowPayload }),
      previewJson: JSON.stringify(workflowPreview),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce({
      ...pending, status: 'applied', jobId: 'job-1', appliedAt: now.toISOString(),
    });
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    workflowMocks.planWorkflowResearch.mockResolvedValue(workflowPreview);

    const result = await approvePendingAction({ id: 'a1', subject, now });

    expect(repoMocks.claimExecution).toHaveBeenCalledWith('a1', 's1', null, null, now.toISOString());
    expect(finalizerMocks.finalizeWorkflowStartAction).toHaveBeenCalledWith({
      actionId: 'a1', subjectId: 's1', type: 'research',
      params: { topic: 'SQLite', subjectId: 's1' }, nowIso: now.toISOString(),
    });
    expect(result.jobId).toBe('job-1');
  });

  it('选区配图批准时重新验证锚点，并原子启动 image-insert job', async () => {
    const workflowPayload = {
      slug: 'page-a',
      anchor: {
        start: 10, end: 29, markdown: 'Selected paragraph.', prefix: '# Title\n\n', suffix: '',
        quote: 'Selected paragraph.', section: 'Context',
      },
      request: { prompt: 'Explain visually', alt: 'Explanation diagram', aspectRatio: '16:9' },
      effectiveAt: payload.effectiveAt,
    };
    const workflowPreview = {
      ...preview,
      kind: 'workflow' as const,
      summary: '为 page-a 生成选区配图',
      diff: null,
      imageInsert: {
        selection: 'Selected paragraph.', prompt: 'Explain visually', alt: 'Explanation diagram',
        aspectRatio: '16:9',
      },
    };
    const pending = record('pending', {
      operation: 'workflow-image-insert-start',
      payloadJson: canonicalJson(workflowPayload),
      payloadHash: hashPendingActionPayload({
        conversationId: 'c1', subjectId: 's1',
        operation: 'workflow-image-insert-start', payload: workflowPayload,
      }),
      previewJson: JSON.stringify(workflowPreview),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce({
      ...pending, status: 'applied', jobId: 'job-1', appliedAt: now.toISOString(),
    });
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    workflowMocks.planWorkflowImageInsert.mockResolvedValue(workflowPreview);

    const result = await approvePendingAction({ id: 'a1', subject, now });

    expect(workflowMocks.planWorkflowImageInsert).toHaveBeenCalledWith(subject, {
      slug: 'page-a', anchor: workflowPayload.anchor, request: workflowPayload.request,
    });
    expect(finalizerMocks.finalizeWorkflowStartAction).toHaveBeenCalledWith({
      actionId: 'a1', subjectId: 's1', type: 'image-insert',
      params: {
        subjectId: 's1', slug: 'page-a',
        anchor: workflowPayload.anchor, request: workflowPayload.request,
      },
      nowIso: now.toISOString(),
    });
    expect(result.jobId).toBe('job-1');
  });

  it('workflow cancel fresh 批准后原子取消并发送取消通知', async () => {
    const workflowPayload = { jobId: 'job-1', effectiveAt: payload.effectiveAt };
    const workflowPreview = {
      ...preview, kind: 'workflow' as const, summary: '取消 research 任务 job-1',
      affectedPages: [], diff: null,
    };
    const pending = record('pending', {
      operation: 'workflow-cancel', payloadJson: canonicalJson(workflowPayload),
      payloadHash: hashPendingActionPayload({ conversationId: 'c1', subjectId: 's1',
        operation: 'workflow-cancel', payload: workflowPayload }),
      previewJson: JSON.stringify(workflowPreview),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce({
      ...pending, status: 'applied', jobId: 'job-1', appliedAt: now.toISOString(),
    });
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    workflowMocks.planWorkflowCancel.mockResolvedValue(workflowPreview);

    await approvePendingAction({ id: 'a1', subject, now });

    expect(repoMocks.claimExecution).toHaveBeenCalledWith(
      'a1', 's1', null, 'job-1', now.toISOString(),
    );
    expect(finalizerMocks.finalizeWorkflowCancelAction).toHaveBeenCalledWith({
      actionId: 'a1', subjectId: 's1', jobId: 'job-1', nowIso: now.toISOString(),
    });
    expect(workflowMocks.reportWorkflowCancellation).toHaveBeenCalledWith('job-1');
  });

  it('history-revert fresh 批准后执行 Saga 并原子最终化原 operation', async () => {
    const historyPayload = { operationId: 'op-old', effectiveAt: payload.effectiveAt };
    const historyPreview = { ...preview, summary: '回滚历史操作 op-old', diff: 'history diff' };
    const pending = record('pending', {
      operation: 'history-revert',
      payloadJson: canonicalJson(historyPayload),
      payloadHash: hashPendingActionPayload({
        conversationId: 'c1', subjectId: 's1', operation: 'history-revert', payload: historyPayload,
      }),
      previewJson: JSON.stringify(historyPreview),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce({
      ...pending, status: 'applied', operationId: 'op-revert', appliedAt: now.toISOString(),
    });
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });

    const result = await approvePendingAction({ id: 'a1', subject, now });

    expect(historyMocks.planHistoryRevert).toHaveBeenCalledWith(subject, 'op-old');
    expect(repoMocks.claimExecution).toHaveBeenCalledWith(
      'a1', 's1', 'op-revert', null, now.toISOString(),
    );
    expect(historyMocks.applyPlannedHistoryRevert).toHaveBeenCalledOnce();
    expect(finalizerMocks.finalizeAppliedHistoryRevertAction).toHaveBeenCalledWith({
      actionId: 'a1', subjectId: 's1', originalOperationId: 'op-old', nowIso: now.toISOString(),
    });
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
    expect(result.status).toBe('applied');
  });

  it('history-revert HEAD 变化时刷新预览，必须重新批准且不执行 Saga', async () => {
    const historyPayload = { operationId: 'op-old', effectiveAt: payload.effectiveAt };
    const historyPreview = { ...preview, summary: '回滚历史操作 op-old', diff: 'history diff' };
    const pending = record('pending', {
      operation: 'history-revert',
      payloadJson: canonicalJson(historyPayload),
      payloadHash: hashPendingActionPayload({
        conversationId: 'c1', subjectId: 's1', operation: 'history-revert', payload: historyPayload,
      }),
      previewJson: JSON.stringify(historyPreview),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce(pending);
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    historyMocks.planHistoryRevert.mockResolvedValueOnce({
      originalOperationId: 'op-old', preHead: 'head-2', changeset: { id: 'op-revert-2' },
      summary: '回滚历史操作 op-old', affectedPages: preview.affectedPages,
      diff: 'refreshed history diff', warnings: ['会覆盖后续修改'],
    });

    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_STALE_PREVIEW', httpStatus: 409 });

    expect(repoMocks.refreshPreview).toHaveBeenCalledOnce();
    expect(historyMocks.applyPlannedHistoryRevert).not.toHaveBeenCalled();
    expect(finalizerMocks.finalizeAppliedHistoryRevertAction).not.toHaveBeenCalled();
  });

  it.each([
    ['create', { title: 'New', body: 'Body', effectiveAt: payload.effectiveAt }, 'planCreatePageInSubject'],
    ['update', { slug: 'page-a', body: 'Body', effectiveAt: payload.effectiveAt }, 'planUpdatePageInSubject'],
    ['patch', {
      slug: 'page-a', edits: [{ oldString: 'old', newString: 'new' }], effectiveAt: payload.effectiveAt,
    }, 'planPatchPageInSubject'],
    ['move', {
      slug: 'page-a', newSlug: 'page-b', effectiveAt: payload.effectiveAt,
    }, 'planMovePageInSubject'],
  ] as const)('%s page plan fresh 批准后 apply 并恰好 enqueue embedding 一次', async (
    operation,
    actionPayload,
    plannerName,
  ) => {
    const pending = record('pending', {
      operation,
      payloadJson: canonicalJson(actionPayload),
      payloadHash: hashPendingActionPayload({
        conversationId: 'c1', subjectId: 's1', operation, payload: actionPayload,
      }),
    });
    const plan = { ...pagePlan, operation };
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce({
      ...pending, status: 'applied', operationId: 'op-1', appliedAt: now.toISOString(),
    });
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    pageMocks[plannerName].mockResolvedValue(plan);

    await approvePendingAction({ id: 'a1', subject, now });

    expect(applyMocks.applyPlannedPageOperation).toHaveBeenCalledWith(plan);
    expect(finalizerMocks.finalizeAppliedPageAction).toHaveBeenCalledOnce();
  });

  it.each([
    ['metadata-patch', { slug: 'page-a', summary: 'Summary', effectiveAt: payload.effectiveAt }, 'planMetadataPatchInSubject'],
    ['link-ensure', {
      sourceSlug: 'page-a', targetSlug: 'page-b', oldString: 'Page B', mode: 'link',
      effectiveAt: payload.effectiveAt,
    }, 'planLinkEnsureInSubject'],
  ] as const)('%s 批准时复用共享 planner、fresh 才 apply + enqueue', async (
    operation,
    actionPayload,
    plannerName,
  ) => {
    const pending = record('pending', {
      operation,
      payloadJson: canonicalJson(actionPayload),
      payloadHash: hashPendingActionPayload({
        conversationId: 'c1', subjectId: 's1', operation, payload: actionPayload,
      }),
    });
    const plan = { ...pagePlan, operation };
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce({
      ...pending, status: 'applied', operationId: 'op-1', appliedAt: now.toISOString(),
    });
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    pageMocks[plannerName].mockResolvedValue(plan);

    await approvePendingAction({ id: 'a1', subject, now });

    expect(pageMocks[plannerName]).toHaveBeenCalledWith(
      subject,
      Object.fromEntries(Object.entries(actionPayload).filter(([key]) => key !== 'effectiveAt')),
      payload.effectiveAt,
    );
    expect(applyMocks.applyPlannedPageOperation).toHaveBeenCalledWith(plan);
    expect(finalizerMocks.finalizeAppliedPageAction).toHaveBeenCalledOnce();
  });

  it('metadata-patch HEAD 变化时只刷新预览，不 apply 或 enqueue', async () => {
    const actionPayload = {
      slug: 'page-a', summary: 'Summary', effectiveAt: payload.effectiveAt,
    };
    const pending = record('pending', {
      operation: 'metadata-patch',
      payloadJson: canonicalJson(actionPayload),
      payloadHash: hashPendingActionPayload({
        conversationId: 'c1', subjectId: 's1', operation: 'metadata-patch', payload: actionPayload,
      }),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending).mockReturnValueOnce(pending);
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    pageMocks.planMetadataPatchInSubject.mockResolvedValue({
      ...pagePlan, operation: 'metadata-patch', preHead: 'head-2', diff: 'diff-2',
    });

    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_STALE_PREVIEW' });

    expect(repoMocks.refreshPreview).toHaveBeenCalledOnce();
    expect(applyMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it.each([
    ['metadata-patch', { slug: 'index', summary: 'x', effectiveAt: payload.effectiveAt },
      'planMetadataPatchInSubject'],
    ['link-ensure', {
      sourceSlug: 'log', targetSlug: 'page-b', oldString: 'Page B', mode: 'link',
      effectiveAt: payload.effectiveAt,
    }, 'planLinkEnsureInSubject'],
  ] as const)('%s 系统页批准时由 page-write 保护层拒绝，且不 apply/enqueue', async (
    operation,
    actionPayload,
    plannerName,
  ) => {
    const pending = record('pending', {
      operation,
      payloadJson: canonicalJson(actionPayload),
      payloadHash: hashPendingActionPayload({
        conversationId: 'c1', subjectId: 's1', operation, payload: actionPayload,
      }),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending);
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    pageMocks[plannerName].mockRejectedValueOnce(new Error('protected system page'));

    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_PLAN_INVALID' });

    expect(pageMocks[plannerName]).toHaveBeenCalledOnce();
    expect(applyMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it('reenrich 入队失败不触发页面 embedding', async () => {
    const workflow = { ...preview, kind: 'workflow', diff: null };
    const reenrichPayload = { slug: 'page-a', effectiveAt: payload.effectiveAt };
    const pending = record('pending', {
      operation: 'reenrich', payloadJson: canonicalJson(reenrichPayload),
      payloadHash: hashPendingActionPayload({ conversationId: 'c1', subjectId: 's1',
        operation: 'reenrich', payload: reenrichPayload }), previewJson: JSON.stringify(workflow),
    });
    repoMocks.getScoped.mockReturnValueOnce(pending);
    repoMocks.claimApproval.mockReturnValue({ ...pending, status: 'approved' });
    reenrichMocks.planReenrich.mockResolvedValue(workflow);
    finalizerMocks.finalizeWorkflowStartAction.mockImplementationOnce(() => {
      throw new Error('enqueue failed');
    });

    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_APPLY_FAILED' });
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it('apply 成功但 enqueue finalization 失败时保持 executing，不误报 apply failed', async () => {
    finalizerMocks.finalizeAppliedPageAction.mockImplementationOnce(() => {
      throw new Error('enqueue failed');
    });

    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({
        code: 'ACTION_IN_PROGRESS',
        httpStatus: 409,
        message: expect.stringMatching(/applied.*finalization.*retried/i),
      });

    expect(applyMocks.applyPlannedPageOperation).toHaveBeenCalledWith(pagePlan);
    expect(repoMocks.markFailed).not.toHaveBeenCalled();
    expect(repoMocks.markApplied).not.toHaveBeenCalled();
  });

  it('planner 或 apply 失败均不执行 finalization', async () => {
    pageMocks.planDeletePageInSubject.mockRejectedValueOnce(new Error('plan failed'));
    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_PLAN_INVALID' });
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();

    vi.clearAllMocks();
    repoMocks.getScoped.mockReturnValue(record());
    repoMocks.claimApproval.mockReturnValue(record('approved', { approvedAt: now.toISOString() }));
    repoMocks.claimExecution.mockReturnValue(true);
    pageMocks.planDeletePageInSubject.mockResolvedValue(pagePlan);
    applyMocks.applyPlannedPageOperation.mockRejectedValueOnce(new Error('apply failed'));
    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_APPLY_FAILED' });
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
    expect(repoMocks.markFailed).toHaveBeenCalledOnce();
  });
});

describe('拒绝与恢复', () => {
  it('拒绝只消费 pending action', () => {
    repoMocks.getScoped.mockReturnValueOnce(record()).mockReturnValueOnce(record('rejected'));
    expect(rejectPendingAction({ id: 'a1', subject, now }).status).toBe('rejected');
    expect(repoMocks.rejectPending).toHaveBeenCalledWith('a1', 's1', now.toISOString());
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it('executing 对应 operation 已 applied 时恢复 action', () => {
    repoMocks.listRecoverable.mockReturnValue([
      record('executing', { operationId: 'op-1' }),
    ]);
    operationMocks.getById.mockReturnValue({ id: 'op-1', status: 'applied' });
    expect(recoverPendingActions(now)).toBe(1);
    expect(finalizerMocks.finalizeAppliedPageAction).toHaveBeenCalledWith({
      actionId: 'a1', subjectId: 's1', nowIso: now.toISOString(),
    });
    expect(repoMocks.markApplied).not.toHaveBeenCalled();
  });

  it('history-revert 恢复时按 payload 最终化原 operation', () => {
    repoMocks.listRecoverable.mockReturnValue([
      record('executing', {
        operation: 'history-revert',
        operationId: 'op-revert',
        payloadJson: canonicalJson({ operationId: 'op-old', effectiveAt: payload.effectiveAt }),
      }),
    ]);
    operationMocks.getById.mockReturnValue({ id: 'op-revert', status: 'applied' });
    expect(recoverPendingActions(now)).toBe(1);
    expect(finalizerMocks.finalizeAppliedHistoryRevertAction).toHaveBeenCalledWith({
      actionId: 'a1', subjectId: 's1', originalOperationId: 'op-old', nowIso: now.toISOString(),
    });
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it('恢复 finalization 失败时保持 executing，后续维护可重试', () => {
    repoMocks.listRecoverable.mockReturnValue([
      record('executing', { operationId: 'op-1' }),
    ]);
    operationMocks.getById.mockReturnValue({ id: 'op-1', status: 'applied' });
    finalizerMocks.finalizeAppliedPageAction
      .mockImplementationOnce(() => { throw new Error('enqueue failed'); })
      .mockReturnValueOnce(undefined);

    expect(recoverPendingActions(now)).toBe(0);
    expect(repoMocks.markFailed).not.toHaveBeenCalled();
    expect(recoverPendingActions(now)).toBe(1);
    expect(finalizerMocks.finalizeAppliedPageAction).toHaveBeenCalledTimes(2);
  });

  it('expire/maintain 不触发 embedding', () => {
    repoMocks.expirePending.mockReturnValue(1);
    repoMocks.pruneTerminal.mockReturnValue(1);
    expect(maintainPendingActions(now)).toMatchObject({ expired: 1, pruned: 1 });
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });
});
