import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockPlan = vi.fn();
const mockApply = vi.fn();
const mockMarkReverted = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  markReverted: (id: unknown) => mockMarkReverted(id),
}));
vi.mock('@/server/services/history-tools', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/history-tools')>(
    '@/server/services/history-tools',
  );
  return {
    ...actual,
    planHistoryRevert: (...args: unknown[]) => mockPlan(...args),
    applyPlannedHistoryRevert: (...args: unknown[]) => mockApply(...args),
  };
});

import { HistoryOperationError } from '@/server/services/history-tools';
import { POST } from '../route';

function call(id: string, body: unknown = { subjectId: 's1' }) {
  const req = new NextRequest(`http://localhost/api/history/${id}/revert`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockPlan.mockResolvedValue({ originalOperationId: 'opA', preHead: 'head-1' });
  mockApply.mockResolvedValue({
    originalOperationId: 'opA', operationId: 'op-new',
    newCommitSha: 'newsha', affectedSlugs: ['a'],
  });
});

describe('POST /api/history/[id]/revert', () => {
  it('未知或跨 Subject operation → 404，不写入', async () => {
    mockPlan.mockRejectedValue(new HistoryOperationError('HISTORY_NOT_FOUND', 'not found'));
    expect((await call('nope')).status).toBe(404);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockMarkReverted).not.toHaveBeenCalled();
  });

  it('已 reverted operation → 409', async () => {
    mockPlan.mockRejectedValue(new HistoryOperationError(
      'HISTORY_ALREADY_REVERTED',
      'already reverted',
    ));
    expect((await call('opA')).status).toBe(409);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('inverse 校验失败 → 422 带 errors，不 apply/markReverted', async () => {
    mockPlan.mockRejectedValue(new HistoryOperationError(
      'HISTORY_REVERT_INVALID',
      'invalid',
      ['坏链'],
    ));
    const res = await call('opA');
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual(['坏链']);
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockMarkReverted).not.toHaveBeenCalled();
  });

  it('合法 → 200，复用共享 plan/apply 并标记原 operation', async () => {
    const res = await call('opA');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revertedOperationId: 'opA', newCommitSha: 'newsha', affectedSlugs: ['a'],
    });
    expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), 'opA');
    expect(mockApply).toHaveBeenCalledOnce();
    expect(mockMarkReverted).toHaveBeenCalledWith('opA');
  });
});
