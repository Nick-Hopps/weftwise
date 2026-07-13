import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { authMock, subjectMock, getRunMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  subjectMock: vi.fn(),
  getRunMock: vi.fn(),
}));

vi.mock('@/server/middleware/auth', () => ({ requireAuth: authMock }));
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
    getResearchRun: getRunMock,
  };
});

import { ResearchApprovalServiceError } from '@/server/services/research-approval-service';
import { GET } from '../route';

function call(id = 'run-1') {
  const request = new NextRequest('http://localhost/api/research-runs/run-1?subjectId=s1');
  return GET(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  authMock.mockReset().mockReturnValue(null);
  subjectMock.mockReset().mockReturnValue({
    subject: { id: 's1', slug: 'general' },
    error: null,
  });
  getRunMock.mockReset().mockReturnValue({ id: 'run-1', status: 'awaiting-approval' });
});

describe('GET /api/research-runs/[id]', () => {
  it('执行鉴权与 required Subject 解析，并保持严格只读', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(subjectMock).toHaveBeenCalledWith(expect.anything(), { required: true });
    expect(getRunMock).toHaveBeenCalledWith('run-1', 's1');
    expect(await response.json()).toEqual({
      run: { id: 'run-1', status: 'awaiting-approval' },
    });
  });

  it('鉴权失败直接返回，不读取 run', async () => {
    authMock.mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const response = await call();
    expect(response.status).toBe(401);
    expect(subjectMock).not.toHaveBeenCalled();
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it('跨 Subject 与不存在统一返回 404 RESEARCH_RUN_NOT_FOUND', async () => {
    getRunMock.mockImplementation(() => {
      throw new ResearchApprovalServiceError(
        'RESEARCH_RUN_NOT_FOUND',
        'Research run not found.',
        404,
      );
    });
    const response = await call('other-run');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Research run not found.',
      code: 'RESEARCH_RUN_NOT_FOUND',
    });
  });
});
