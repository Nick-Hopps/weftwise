import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { authMock, csrfMock, subjectMock, reselectMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  csrfMock: vi.fn(),
  subjectMock: vi.fn(),
  reselectMock: vi.fn(),
}));

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: authMock,
  requireCsrf: csrfMock,
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: subjectMock,
}));
vi.mock('@/server/services/research-approval-service', () => {
  class ResearchApprovalServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly httpStatus: number,
      readonly run?: unknown,
    ) {
      super(message);
      this.name = 'ResearchApprovalServiceError';
    }
  }
  return {
    ResearchApprovalServiceError,
    reselectResearchRun: reselectMock,
  };
});

import { ResearchApprovalServiceError } from '@/server/services/research-approval-service';
import { POST } from '../route';

function call(
  body: unknown = { subjectId: 's1', expectedVersion: 3 },
  id = 'run-1',
) {
  const request = new NextRequest(`http://localhost/api/research-runs/${id}/reselect`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  authMock.mockReset().mockReturnValue(null);
  csrfMock.mockReset().mockReturnValue(null);
  subjectMock.mockReset().mockReturnValue({
    subject: { id: 's1', slug: 'general' },
    error: null,
  });
  reselectMock.mockReset().mockReturnValue({
    run: { id: 'run-1', status: 'awaiting-approval', version: 4 },
  });
});

describe('POST /api/research-runs/[id]/reselect', () => {
  it('执行 auth/CSRF/required Subject 后按 expectedVersion 回到候选选择', async () => {
    const response = await call();
    expect(response.status).toBe(202);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(csrfMock).toHaveBeenCalledTimes(1);
    expect(subjectMock).toHaveBeenCalledWith(expect.anything(), {
      required: true,
      body: { subjectId: 's1', expectedVersion: 3 },
    });
    expect(reselectMock).toHaveBeenCalledWith({
      runId: 'run-1',
      subjectId: 's1',
      expectedVersion: 3,
    });
    expect(await response.json()).toEqual({
      run: { id: 'run-1', status: 'awaiting-approval', version: 4 },
    });
  });

  it.each([
    [{ subjectId: 's1' }],
    [{ subjectId: 's1', expectedVersion: 0 }],
    [{ subjectId: 's1', expectedVersion: 1.5 }],
    [{ subjectId: 's1', expectedVersion: 3, extra: true }],
    [{ expectedVersion: 3 }],
  ])('非法 body %j 返回 400 且不触达服务层', async (body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(reselectMock).not.toHaveBeenCalled();
  });

  it('不可重新选择的 run 返回 409 与最新 run', async () => {
    reselectMock.mockImplementation(() => {
      throw new ResearchApprovalServiceError(
        'RESEARCH_RUN_NOT_RETRYABLE',
        'Research run cannot be retried.',
        409,
        { id: 'run-1', status: 'failed' } as never,
      );
    });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Research run cannot be retried.',
      code: 'RESEARCH_RUN_NOT_RETRYABLE',
      run: { id: 'run-1', status: 'failed' },
    });
  });

  it('auth、CSRF 或 subject 失败时立即返回', async () => {
    authMock.mockReturnValueOnce(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
    expect((await call()).status).toBe(401);
    expect(csrfMock).not.toHaveBeenCalled();

    authMock.mockReturnValue(null);
    csrfMock.mockReturnValueOnce(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
    expect((await call()).status).toBe(403);
    expect(reselectMock).not.toHaveBeenCalled();

    csrfMock.mockReturnValue(null);
    subjectMock.mockReturnValueOnce({
      subject: null,
      error: NextResponse.json({ error: 'subject required' }, { status: 400 }),
    });
    expect((await call()).status).toBe(400);
    expect(reselectMock).not.toHaveBeenCalled();
  });
});
