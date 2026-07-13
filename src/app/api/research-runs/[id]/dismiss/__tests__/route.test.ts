import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { authMock, csrfMock, subjectMock, dismissMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  csrfMock: vi.fn(),
  subjectMock: vi.fn(),
  dismissMock: vi.fn(),
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
    dismissResearchRun: dismissMock,
  };
});

import { ResearchApprovalServiceError } from '@/server/services/research-approval-service';
import { POST } from '../route';

function call(body: unknown = { subjectId: 's1' }, id = 'run-1') {
  const request = new NextRequest(`http://localhost/api/research-runs/${id}/dismiss`, {
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
  dismissMock.mockReset().mockReturnValue({ id: 'run-1', status: 'dismissed', version: 2 });
});

describe('POST /api/research-runs/[id]/dismiss', () => {
  it('执行 auth/CSRF/required Subject 后显式驳回 run', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(csrfMock).toHaveBeenCalledTimes(1);
    expect(subjectMock).toHaveBeenCalledWith(expect.anything(), {
      required: true,
      body: { subjectId: 's1' },
    });
    expect(dismissMock).toHaveBeenCalledWith('run-1', 's1');
    expect(await response.json()).toEqual({
      run: { id: 'run-1', status: 'dismissed', version: 2 },
    });
  });

  it('已批准或非 awaiting run 返回 409', async () => {
    dismissMock.mockImplementation(() => {
      throw new ResearchApprovalServiceError(
        'RESEARCH_RUN_NOT_APPROVABLE',
        'Research run is not awaiting approval.',
        409,
      );
    });
    const response = await call();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('RESEARCH_RUN_NOT_APPROVABLE');
  });

  it('未知字段或缺 subjectId 返回 400，不调用 service', async () => {
    const response = await call({ subjectId: 's1', candidateIds: [] });
    expect(response.status).toBe(400);
    expect(dismissMock).not.toHaveBeenCalled();
  });

  it('CSRF 失败直接返回', async () => {
    csrfMock.mockReturnValue(NextResponse.json({ error: 'CSRF' }, { status: 403 }));
    const response = await call();
    expect(response.status).toBe(403);
    expect(subjectMock).not.toHaveBeenCalled();
    expect(dismissMock).not.toHaveBeenCalled();
  });
});
