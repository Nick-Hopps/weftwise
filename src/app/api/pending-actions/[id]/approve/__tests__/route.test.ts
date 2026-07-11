import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.fn();
const mockCsrf = vi.fn();
const mockResolve = vi.fn();
const mockApprove = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...args: unknown[]) => mockAuth(...args),
  requireCsrf: (...args: unknown[]) => mockCsrf(...args),
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mockResolve(...args),
}));
vi.mock('@/server/services/pending-action-service', () => {
  class PendingActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly httpStatus: number,
      readonly action?: unknown,
    ) {
      super(message);
    }
  }
  return {
    PendingActionError,
    approvePendingAction: (...args: unknown[]) => mockApprove(...args),
  };
});

import { PendingActionError } from '@/server/services/pending-action-service';
import { POST } from '../route';

function call(id = 'a1', body: unknown = { subjectId: 's1', operation: 'delete', payload: { slug: 'x' } }) {
  const request = new NextRequest(`http://localhost/api/pending-actions/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(null);
  mockCsrf.mockReset().mockReturnValue(null);
  mockResolve.mockReset().mockReturnValue({
    subject: { id: 's1', slug: 'general' },
    error: null,
  });
  mockApprove.mockReset().mockResolvedValue({ actionId: 'a1', status: 'applied' });
});

describe('POST /api/pending-actions/[id]/approve', () => {
  it('执行鉴权与 CSRF，忽略客户端 operation/payload，只传 id 与 subject', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(mockAuth).toHaveBeenCalledTimes(1);
    expect(mockCsrf).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), {
      required: true,
      body: { subjectId: 's1', operation: 'delete', payload: { slug: 'x' } },
    });
    expect(mockApprove).toHaveBeenCalledWith({
      id: 'a1',
      subject: { id: 's1', slug: 'general' },
    });
    expect(await res.json()).toEqual({ action: { actionId: 'a1', status: 'applied' } });
  });

  it('预览陈旧返回 409，并携带服务端刷新的 action', async () => {
    const refreshed = { actionId: 'a1', status: 'pending', diff: 'new diff' };
    mockApprove.mockRejectedValue(
      new PendingActionError('ACTION_STALE_PREVIEW', 'Review refreshed action.', 409, refreshed as never),
    );
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Review refreshed action.',
      code: 'ACTION_STALE_PREVIEW',
      action: refreshed,
    });
  });

  it('已过期返回 410', async () => {
    mockApprove.mockRejectedValue(new PendingActionError('ACTION_EXPIRED', 'Action expired.', 410));
    const res = await call();
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('ACTION_EXPIRED');
  });
});
