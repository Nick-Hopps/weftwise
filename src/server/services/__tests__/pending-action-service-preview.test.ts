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
}));
vi.mock('../page-write', () => pagePlanMocks);

const reenrichMocks = vi.hoisted(() => ({ planReenrich: vi.fn() }));
vi.mock('../reenrich-enqueue', () => reenrichMocks);

import {
  PendingActionError,
  createPendingActionPreview,
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
