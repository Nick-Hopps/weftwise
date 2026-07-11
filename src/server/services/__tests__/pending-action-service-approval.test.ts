import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingActionPreview, Subject } from '@/lib/contracts';
import type { PendingActionRecord } from '../../db/repos/pending-actions-repo';
import { canonicalJson, hashPendingActionPayload } from '../pending-action-payload';

const conversationMocks = vi.hoisted(() => ({ getConversation: vi.fn() }));
vi.mock('../../db/repos/conversations-repo', () => conversationMocks);
const repoMocks = vi.hoisted(() => ({
  getScoped: vi.fn(), claimApproval: vi.fn(), claimExecution: vi.fn(), refreshPreview: vi.fn(),
  markApplied: vi.fn(), markFailed: vi.fn(), rejectPending: vi.fn(), expirePending: vi.fn(() => 0),
  listRecoverable: vi.fn((): PendingActionRecord[] => []), pruneTerminal: vi.fn(() => 0),
}));
vi.mock('../../db/repos/pending-actions-repo', () => repoMocks);
const pageMocks = vi.hoisted(() => ({
  planDeletePageInSubject: vi.fn(), planCreatePageInSubject: vi.fn(),
  planUpdatePageInSubject: vi.fn(), planPatchPageInSubject: vi.fn(),
}));
vi.mock('../page-write', () => pageMocks);
const applyMocks = vi.hoisted(() => ({ applyPlannedPageOperation: vi.fn() }));
vi.mock('../../wiki/page-operation-plan', () => applyMocks);
const reenrichMocks = vi.hoisted(() => ({ planReenrich: vi.fn(), enqueueReenrich: vi.fn() }));
vi.mock('../reenrich-enqueue', () => reenrichMocks);
const operationMocks = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock('../../db/repos/operations-repo', () => operationMocks);

import {
  approvePendingAction, rejectPendingAction, recoverPendingActions,
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
  vi.clearAllMocks();
  conversationMocks.getConversation.mockReturnValue({ id: 'c1', subjectId: 's1' });
  repoMocks.getScoped.mockReturnValue(record());
  repoMocks.claimApproval.mockReturnValue(record('approved', { approvedAt: now.toISOString() }));
  repoMocks.claimExecution.mockReturnValue(true);
  repoMocks.markApplied.mockReturnValue(true);
  repoMocks.rejectPending.mockReturnValue(true);
  repoMocks.refreshPreview.mockReturnValue(true);
  pageMocks.planDeletePageInSubject.mockResolvedValue(pagePlan);
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
    expect(repoMocks.markApplied).toHaveBeenCalled();
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
  });

  it('payload hash 不匹配时不规划不执行', async () => {
    repoMocks.getScoped.mockReturnValue(record('pending', { payloadHash: 'tampered' }));
    repoMocks.claimApproval.mockReturnValue(record('approved', { payloadHash: 'tampered' }));
    await expect(approvePendingAction({ id: 'a1', subject, now }))
      .rejects.toMatchObject({ code: 'ACTION_PAYLOAD_MISMATCH' });
    expect(pageMocks.planDeletePageInSubject).not.toHaveBeenCalled();
    expect(applyMocks.applyPlannedPageOperation).not.toHaveBeenCalled();
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
  });
});

describe('拒绝与恢复', () => {
  it('拒绝只消费 pending action', () => {
    repoMocks.getScoped.mockReturnValueOnce(record()).mockReturnValueOnce(record('rejected'));
    expect(rejectPendingAction({ id: 'a1', subject, now }).status).toBe('rejected');
    expect(repoMocks.rejectPending).toHaveBeenCalledWith('a1', 's1', now.toISOString());
  });

  it('executing 对应 operation 已 applied 时恢复 action', () => {
    repoMocks.listRecoverable.mockReturnValue([
      record('executing', { operationId: 'op-1' }),
    ]);
    operationMocks.getById.mockReturnValue({ id: 'op-1', status: 'applied' });
    expect(recoverPendingActions(now)).toBe(1);
    expect(repoMocks.markApplied).toHaveBeenCalledWith('a1', 's1', now.toISOString());
  });
});
