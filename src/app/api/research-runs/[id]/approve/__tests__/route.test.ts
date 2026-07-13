import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { authMock, csrfMock, subjectMock, approveMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  csrfMock: vi.fn(),
  subjectMock: vi.fn(),
  approveMock: vi.fn(),
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
    approveResearchRun: approveMock,
  };
});

import { ResearchApprovalServiceError } from '@/server/services/research-approval-service';
import { POST } from '../route';

const CANDIDATE_ID = 'a'.repeat(64);

function call(body: unknown, id = 'run-1') {
  const request = new NextRequest(`http://localhost/api/research-runs/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(request, { params: Promise.resolve({ id }) });
}

function validBody() {
  return {
    candidateIds: [CANDIDATE_ID],
    expectedVersion: 1,
    idempotencyKey: 'approval-key-1',
    subjectId: 's1',
  };
}

beforeEach(() => {
  authMock.mockReset().mockReturnValue(null);
  csrfMock.mockReset().mockReturnValue(null);
  subjectMock.mockReset().mockReturnValue({
    subject: { id: 's1', slug: 'general' },
    error: null,
  });
  approveMock.mockReset().mockReturnValue({
    run: { id: 'run-1', status: 'importing', version: 2 },
    coordinatorJobId: 'coordinator-1',
    replayed: false,
  });
});

describe('POST /api/research-runs/[id]/approve', () => {
  it('只把服务端 candidate ID/version/key 传给批准服务，首次返回 202', async () => {
    const response = await call(validBody());
    expect(response.status).toBe(202);
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(csrfMock).toHaveBeenCalledTimes(1);
    expect(subjectMock).toHaveBeenCalledWith(expect.anything(), {
      required: true,
      body: validBody(),
    });
    expect(approveMock).toHaveBeenCalledWith({
      runId: 'run-1',
      subjectId: 's1',
      candidateIds: [CANDIDATE_ID],
      expectedVersion: 1,
      idempotencyKey: 'approval-key-1',
    });
    expect(await response.json()).toMatchObject({
      coordinatorJobId: 'coordinator-1',
      replayed: false,
    });
  });

  it('同 key/hash 幂等重放返回 200', async () => {
    approveMock.mockReturnValue({
      run: { id: 'run-1', status: 'importing', version: 2 },
      coordinatorJobId: 'coordinator-1',
      replayed: true,
    });
    const response = await call(validBody());
    expect(response.status).toBe(200);
    expect((await response.json()).replayed).toBe(true);
  });

  it.each([
    ['空 selection', { ...validBody(), candidateIds: [] }],
    ['重复 candidate', { ...validBody(), candidateIds: [CANDIDATE_ID, CANDIDATE_ID] }],
    ['未知字段 URL', { ...validBody(), url: 'https://attacker.example' }],
    ['非法 candidate ID', { ...validBody(), candidateIds: ['not-an-id'] }],
    ['非正整数版本', { ...validBody(), expectedVersion: 0 }],
    ['空幂等键', { ...validBody(), idempotencyKey: ' ' }],
  ] as const)('%s 在调用 subject/repo 前返回 400', async (_label, body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Research candidate selection is invalid.',
      code: 'RESEARCH_SELECTION_INVALID',
    });
    expect(subjectMock).not.toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('鉴权或 CSRF 失败时不解析 Subject、不批准', async () => {
    csrfMock.mockReturnValue(NextResponse.json({ error: 'CSRF' }, { status: 403 }));
    const response = await call(validBody());
    expect(response.status).toBe(403);
    expect(subjectMock).not.toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('stale version 返回 409 与服务端最新 run', async () => {
    approveMock.mockImplementation(() => {
      throw new ResearchApprovalServiceError(
        'RESEARCH_RUN_STALE',
        'Research run changed. Refresh and review it again.',
        409,
        { id: 'run-1', status: 'awaiting-approval', version: 2 } as never,
      );
    });
    const response = await call(validBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Research run changed. Refresh and review it again.',
      code: 'RESEARCH_RUN_STALE',
      run: { id: 'run-1', status: 'awaiting-approval', version: 2 },
    });
  });
});
