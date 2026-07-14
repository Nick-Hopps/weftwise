import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { authMock, csrfMock, subjectMock, retryMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  csrfMock: vi.fn(),
  subjectMock: vi.fn(),
  retryMock: vi.fn(),
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
    retryResearchRunImport: retryMock,
  };
});

import { ResearchApprovalServiceError } from '@/server/services/research-approval-service';
import { POST } from '../route';

function call(
  body: unknown = { subjectId: 's1', expectedVersion: 3 },
  id = 'run-1',
) {
  const request = new NextRequest(`http://localhost/api/research-runs/${id}/retry`, {
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
  retryMock.mockReset().mockReturnValue({
    run: { id: 'run-1', status: 'importing', version: 4 },
    coordinatorJobId: 'coordinator-2',
  });
});

describe('POST /api/research-runs/[id]/retry', () => {
  it('执行 auth/CSRF/required Subject 后按 expectedVersion 重试导入', async () => {
    const response = await call();
    expect(response.status).toBe(202);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(csrfMock).toHaveBeenCalledTimes(1);
    expect(subjectMock).toHaveBeenCalledWith(expect.anything(), {
      required: true,
      body: { subjectId: 's1', expectedVersion: 3 },
    });
    expect(retryMock).toHaveBeenCalledWith({
      runId: 'run-1',
      subjectId: 's1',
      expectedVersion: 3,
    });
    expect(await response.json()).toEqual({
      run: { id: 'run-1', status: 'importing', version: 4 },
      coordinatorJobId: 'coordinator-2',
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
    expect(retryMock).not.toHaveBeenCalled();
  });

  it('不可重试的 run 返回 409 与稳定错误码', async () => {
    retryMock.mockImplementation(() => {
      throw new ResearchApprovalServiceError(
        'RESEARCH_RUN_NOT_RETRYABLE',
        'Research run cannot be retried.',
        409,
        { id: 'run-1', status: 'partial' } as never,
      );
    });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Research run cannot be retried.',
      code: 'RESEARCH_RUN_NOT_RETRYABLE',
      run: { id: 'run-1', status: 'partial' },
    });
  });

  it('版本陈旧返回 409 stale', async () => {
    retryMock.mockImplementation(() => {
      throw new ResearchApprovalServiceError(
        'RESEARCH_RUN_STALE',
        'Research run changed. Refresh and review it again.',
        409,
      );
    });
    const response = await call();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('RESEARCH_RUN_STALE');
  });
});
