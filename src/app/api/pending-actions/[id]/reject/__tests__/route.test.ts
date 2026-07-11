import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.fn();
const mockCsrf = vi.fn();
const mockResolve = vi.fn();
const mockReject = vi.fn();

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
    rejectPendingAction: (...args: unknown[]) => mockReject(...args),
  };
});

import { PendingActionError } from '@/server/services/pending-action-service';
import { POST } from '../route';

function call(id = 'a1', body: unknown = { subjectId: 's1', payload: { forged: true } }) {
  const request = new NextRequest(`http://localhost/api/pending-actions/${id}/reject`, {
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
  mockReject.mockReset().mockReturnValue({ actionId: 'a1', status: 'rejected' });
});

describe('POST /api/pending-actions/[id]/reject', () => {
  it('执行鉴权与 CSRF，只把 id 和已解析 subject 交给 service', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(mockAuth).toHaveBeenCalledTimes(1);
    expect(mockCsrf).toHaveBeenCalledTimes(1);
    expect(mockReject).toHaveBeenCalledWith({
      id: 'a1',
      subject: { id: 's1', slug: 'general' },
    });
    expect(await res.json()).toEqual({ action: { actionId: 'a1', status: 'rejected' } });
  });

  it('不存在或跨 subject 时返回 404', async () => {
    mockReject.mockImplementation(() => {
      throw new PendingActionError('ACTION_NOT_FOUND', 'Action not found.', 404);
    });
    const res = await call('other');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('ACTION_NOT_FOUND');
  });
});
