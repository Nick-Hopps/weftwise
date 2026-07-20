import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  requeueJobWithParams: vi.fn(),
  getSource: vi.fn(),
  getJobEvents: vi.fn(),
  resolveSubject: vi.fn(),
  createGrant: vi.fn(),
  deleteGrant: vi.fn(),
  emit: vi.fn(),
  retryResearchIngestJob: vi.fn(),
}));

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: () => null,
  requireCsrf: () => null,
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mocks.resolveSubject(...args),
}));
vi.mock('@/server/jobs/queue', () => ({
  get: (...args: unknown[]) => mocks.getJob(...args),
  requeueJobWithParams: (...args: unknown[]) => mocks.requeueJobWithParams(...args),
}));
vi.mock('@/server/jobs/events', () => ({
  emit: (...args: unknown[]) => mocks.emit(...args),
}));
vi.mock('@/server/db/repos/sources-repo', () => ({
  getSource: (...args: unknown[]) => mocks.getSource(...args),
}));
vi.mock('@/server/db/repos/jobs-repo', () => ({
  getJobEvents: (...args: unknown[]) => mocks.getJobEvents(...args),
}));
vi.mock('@/server/services/research-approval-service', () => ({
  retryResearchIngestJob: (...args: unknown[]) => mocks.retryResearchIngestJob(...args),
  ResearchApprovalServiceError: class ResearchApprovalServiceError extends Error {},
}));
vi.mock('@/server/sources/source-auth-grant', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/server/sources/source-auth-grant')>();
  return {
    ...original,
    createSourceAuthGrant: (...args: unknown[]) => mocks.createGrant(...args),
    deleteSourceAuthGrant: (...args: unknown[]) => mocks.deleteGrant(...args),
  };
});

import { POST } from '../route';

const failedJob = {
  id: 'job-1',
  type: 'ingest',
  status: 'failed',
  subjectId: 'sub-1',
  paramsJson: JSON.stringify({
    sourceId: 'source-1',
    filename: 'web-example.html',
    subjectId: 'sub-1',
  }),
  resultJson: JSON.stringify({ error: { message: 'Authentication required (HTTP 401)' } }),
};

const urlSource = {
  id: 'source-1',
  subjectId: 'sub-1',
  filename: 'web-example.html',
  metadataJson: JSON.stringify({ kind: 'url', originUrl: 'https://example.com/private' }),
};

function authEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    jobId: 'job-1',
    type: 'ingest:auth-required',
    message: 'Authentication required',
    dataJson: JSON.stringify({
      code: 'url-auth-required',
      status: 401,
      authOrigin: 'https://example.com',
      sourceId: 'source-1',
      ...overrides,
    }),
    createdAt: '2026-07-20T00:00:00.000Z',
  };
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/jobs/job-1/url-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subjectId: 'sub-1', ...body }),
  });
}

function call(body: Record<string, unknown>) {
  return POST(request(body), { params: Promise.resolve({ id: 'job-1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSubject.mockReturnValue({
    subject: { id: 'sub-1', slug: 'general' },
    error: null,
  });
  mocks.getJob.mockReturnValue(failedJob);
  mocks.getSource.mockReturnValue(urlSource);
  mocks.getJobEvents.mockReturnValue([authEvent()]);
  mocks.createGrant.mockReturnValue({
    id: '11111111-1111-4111-8111-111111111111',
    expiresAt: '2026-07-20T02:00:00.000Z',
  });
  mocks.requeueJobWithParams.mockReturnValue({ ...failedJob, status: 'pending' });
  mocks.retryResearchIngestJob.mockReturnValue({
    run: { id: 'run-1', subjectId: 'sub-1', status: 'importing', version: 3 },
  });
});

describe('POST /api/jobs/[id]/url-auth', () => {
  it('202：加密创建 grant、只把 grant ID 写入 job，并重排同一任务', async () => {
    const response = await call({
      cookie: 'Cookie: session=secret',
      authorization: 'Authorization: Bearer token',
    });

    expect(response.status).toBe(202);
    expect(mocks.createGrant).toHaveBeenCalledWith({
      jobId: 'job-1',
      sourceId: 'source-1',
      authOrigin: 'https://example.com',
      cookie: 'session=secret',
      authorization: 'Bearer token',
    });
    expect(mocks.requeueJobWithParams).toHaveBeenCalledWith('job-1', {
      sourceAuthGrantId: '11111111-1111-4111-8111-111111111111',
    });
    expect(JSON.stringify(mocks.requeueJobWithParams.mock.calls)).not.toContain('session=secret');
    expect(mocks.emit).toHaveBeenCalledWith(
      'job-1',
      'job:retrying',
      expect.any(String),
      { manual: true, authenticated: true },
    );
    await expect(response.json()).resolves.toEqual({
      jobId: 'job-1',
      status: 'pending',
      expiresAt: '2026-07-20T02:00:00.000Z',
    });
  });

  it('400：没有 Cookie/Authorization 或包含换行注入', async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ cookie: 'a=b\r\nX-Evil: 1' })).status).toBe(400);
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it('409：任务没有当前 auth-required 事件，不接受任意失败任务附加凭证', async () => {
    mocks.getJobEvents.mockReturnValue([]);
    const response = await call({ cookie: 'session=secret' });
    expect(response.status).toBe(409);
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it('404：当前 Subject、job 与 source 必须一致', async () => {
    mocks.resolveSubject.mockReturnValue({
      subject: { id: 'sub-other', slug: 'other' },
      error: null,
    });
    expect((await call({ cookie: 'session=secret' })).status).toBe(404);
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it('202：Research child 把 grant ID 交给 provenance 原子恢复并返回最新 run', async () => {
    mocks.getJob.mockReturnValue({
      ...failedJob,
      paramsJson: JSON.stringify({
        sourceId: 'source-1',
        filename: 'web-example.html',
        subjectId: 'sub-1',
        sourceAuthGrantId: 'old-grant',
        researchProvenance: {
          runId: 'run-1',
          approvalId: 'approval-1',
          candidateId: 'candidate-1',
        },
      }),
    });
    const response = await call({ cookie: 'session=secret' });

    expect(response.status).toBe(202);
    expect(mocks.retryResearchIngestJob).toHaveBeenCalledWith({
      runId: 'run-1',
      subjectId: 'sub-1',
      approvalId: 'approval-1',
      candidateId: 'candidate-1',
      ingestJobId: 'job-1',
      sourceAuthGrantId: '11111111-1111-4111-8111-111111111111',
    });
    expect(mocks.requeueJobWithParams).not.toHaveBeenCalled();
    expect(mocks.deleteGrant).toHaveBeenCalledWith('old-grant');
    expect(mocks.emit).toHaveBeenCalledWith(
      'job-1',
      'job:retrying',
      expect.any(String),
      { manual: true, authenticated: true, research: true, runId: 'run-1' },
    );
    await expect(response.json()).resolves.toMatchObject({
      jobId: 'job-1',
      status: 'pending',
      researchRun: { id: 'run-1', status: 'importing' },
    });
  });

  it('Research 原子恢复失败时补偿删除新 grant，不清理旧 grant', async () => {
    mocks.getJob.mockReturnValue({
      ...failedJob,
      paramsJson: JSON.stringify({
        sourceId: 'source-1',
        filename: 'web-example.html',
        subjectId: 'sub-1',
        sourceAuthGrantId: 'old-grant',
        researchProvenance: {
          runId: 'run-1',
          approvalId: 'approval-1',
          candidateId: 'candidate-1',
        },
      }),
    });
    mocks.retryResearchIngestJob.mockImplementation(() => {
      throw new Error('stale research run');
    });

    const response = await call({ cookie: 'session=secret' });
    expect(response.status).toBe(500);
    expect(mocks.deleteGrant).toHaveBeenCalledTimes(1);
    expect(mocks.deleteGrant).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('409：重排 CAS 失败时补偿删除新 grant', async () => {
    mocks.requeueJobWithParams.mockReturnValue(null);
    const response = await call({ cookie: 'session=secret' });
    expect(response.status).toBe(409);
    expect(mocks.deleteGrant).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
