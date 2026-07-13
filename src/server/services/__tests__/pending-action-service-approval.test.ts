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
}));
vi.mock('../page-write', () => pageMocks);
const applyMocks = vi.hoisted(() => ({
  applyPlannedPageOperation: vi.fn(),
}));
vi.mock('../../wiki/page-operation-plan', () => applyMocks);
const reenrichMocks = vi.hoisted(() => ({ planReenrich: vi.fn(), enqueueReenrich: vi.fn() }));
vi.mock('../reenrich-enqueue', () => reenrichMocks);
const operationMocks = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock('../../db/repos/operations-repo', () => operationMocks);
const finalizerMocks = vi.hoisted(() => ({ finalizeAppliedPageAction: vi.fn() }));
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
  applyMocks.applyPlannedPageOperation.mockResolvedValue({ operationId: 'op-1' });
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

  it('reenrich 只在 claimExecution 后入队一次并保存 jobId', async () => {
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
    reenrichMocks.enqueueReenrich.mockReturnValue({ jobId: 'job-1' });
    const result = await approvePendingAction({ id: 'a1', subject, now });
    expect(repoMocks.claimExecution).toHaveBeenCalledWith('a1', 's1', null, null, now.toISOString());
    expect(reenrichMocks.enqueueReenrich).toHaveBeenCalledTimes(1);
    expect(repoMocks.markApplied).toHaveBeenCalledWith(
      'a1', 's1', now.toISOString(), { jobId: 'job-1' },
    );
    expect(result.jobId).toBe('job-1');
    expect(finalizerMocks.finalizeAppliedPageAction).not.toHaveBeenCalled();
  });

  it.each([
    ['create', { title: 'New', body: 'Body', effectiveAt: payload.effectiveAt }, 'planCreatePageInSubject'],
    ['update', { slug: 'page-a', body: 'Body', effectiveAt: payload.effectiveAt }, 'planUpdatePageInSubject'],
    ['patch', {
      slug: 'page-a', edits: [{ oldString: 'old', newString: 'new' }], effectiveAt: payload.effectiveAt,
    }, 'planPatchPageInSubject'],
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
    reenrichMocks.enqueueReenrich.mockImplementation(() => {
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
