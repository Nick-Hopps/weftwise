import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockAuth = vi.fn();
const mockResolve = vi.fn();
const mockList = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...args: unknown[]) => mockAuth(...args),
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
    listPendingActions: (...args: unknown[]) => mockList(...args),
  };
});

import { PendingActionError } from '@/server/services/pending-action-service';
import { GET } from '../route';

function call(query = 'subjectId=s1&conversationId=c1') {
  return GET(new NextRequest(`http://localhost/api/pending-actions?${query}`));
}

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(null);
  mockResolve.mockReset().mockReturnValue({
    subject: { id: 's1', slug: 'general' },
    error: null,
  });
  mockList.mockReset().mockReturnValue([{ actionId: 'a1', status: 'pending' }]);
});

describe('GET /api/pending-actions', () => {
  it('缺少 conversationId 返回 400，且不解析 subject', async () => {
    const res = await call('subjectId=s1');
    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('要求显式 subject，并返回当前会话的审批操作', async () => {
    const res = await call();
    expect(mockAuth).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), { required: true });
    expect(mockList).toHaveBeenCalledWith({
      conversationId: 'c1',
      subject: { id: 's1', slug: 'general' },
    });
    expect(await res.json()).toEqual({ actions: [{ actionId: 'a1', status: 'pending' }] });
  });

  it('会话不存在或跨 subject 时返回稳定 404 错误', async () => {
    mockList.mockImplementation(() => {
      throw new PendingActionError('ACTION_NOT_FOUND', 'Conversation not found.', 404);
    });
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Conversation not found.',
      code: 'ACTION_NOT_FOUND',
      action: null,
    });
  });

  it('subject 解析失败时原样返回且不调用 service', async () => {
    mockResolve.mockReturnValue({
      subject: null,
      error: NextResponse.json({ error: 'subject required' }, { status: 400 }),
    });
    expect((await call()).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
