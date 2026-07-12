import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const authMock = vi.hoisted(() => vi.fn());
const csrfMock = vi.hoisted(() => vi.fn());
const subjectMock = vi.hoisted(() => vi.fn());
const remediateMock = vi.hoisted(() => vi.fn());
const MockRemediationRequestError = vi.hoisted(() => class RemediationRequestError extends Error {
  constructor(
    readonly status: 400 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemediationRequestError';
  }
});

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...args: unknown[]) => authMock(...args),
  requireCsrf: (...args: unknown[]) => csrfMock(...args),
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => subjectMock(...args),
}));
vi.mock('@/server/services/remediation-service', () => ({
  RemediationRequestError: MockRemediationRequestError,
  remediate: (...args: unknown[]) => remediateMock(...args),
}));

import { RemediationRequestError } from '@/server/services/remediation-service';
import { POST, runtime } from '../route';

const SUBJECT = {
  id: 's1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-07-13T09:00:00.000Z',
  updatedAt: '2026-07-13T09:00:00.000Z',
};
const FINDING_ID = 'a'.repeat(64);

function request(body: unknown) {
  return new NextRequest('http://localhost/api/health/remediations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string) {
  return new NextRequest('http://localhost/api/health/remediations', {
    method: 'POST',
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue(null);
  csrfMock.mockReturnValue(null);
  subjectMock.mockReturnValue({ subject: SUBJECT, error: null });
  remediateMock.mockResolvedValue({ jobId: 'job-1', deduplicated: false });
});

describe('POST /api/health/remediations', () => {
  it('固定使用 nodejs runtime', () => {
    expect(runtime).toBe('nodejs');
  });

  it('成功返回 202 与幂等标记，并传入严格提取的 subject 参数', async () => {
    const body = {
      lintJobId: 'lint-1',
      findingIds: [FINDING_ID],
      action: 'fix',
      subjectId: 's1',
    };
    const req = request(body);
    const response = await POST(req);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ jobId: 'job-1', deduplicated: false });
    expect(subjectMock).toHaveBeenCalledWith(req, { required: true, body });
    expect(remediateMock).toHaveBeenCalledWith({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [FINDING_ID],
      action: 'fix',
    });
  });

  it('service 的稳定错误码与消息原样返回', async () => {
    remediateMock.mockRejectedValue(
      new RemediationRequestError(409, 'stale-snapshot', 'Health snapshot changed'),
    );
    const response = await POST(request({
      lintJobId: 'old',
      findingIds: [FINDING_ID],
      action: 'fix',
      subjectId: 's1',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Health snapshot changed',
      code: 'stale-snapshot',
    });
  });

  it('Auth 失败优先返回，不执行 CSRF、JSON、subject 或 service', async () => {
    authMock.mockReturnValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
    const response = await POST(rawRequest('{'));

    expect(response.status).toBe(401);
    expect(csrfMock).not.toHaveBeenCalled();
    expect(subjectMock).not.toHaveBeenCalled();
    expect(remediateMock).not.toHaveBeenCalled();
  });

  it('CSRF 失败在 JSON、subject 与 service 前返回', async () => {
    csrfMock.mockReturnValue(NextResponse.json({ error: 'csrf' }, { status: 403 }));
    const response = await POST(rawRequest('{'));

    expect(response.status).toBe(403);
    expect(subjectMock).not.toHaveBeenCalled();
    expect(remediateMock).not.toHaveBeenCalled();
  });

  it('损坏 JSON 返回稳定 400，不解析 subject 或调用 service', async () => {
    const response = await POST(rawRequest('{'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      code: 'invalid-json',
    });
    expect(subjectMock).not.toHaveBeenCalled();
    expect(remediateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['数组', []],
    ['字符串', 'body'],
  ])('JSON body 为非普通对象（%s）→ 400', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'JSON body must be an object',
      code: 'invalid-body',
    });
    expect(subjectMock).not.toHaveBeenCalled();
    expect(remediateMock).not.toHaveBeenCalled();
  });

  it('subject 解析失败时直接回传，且不调用 service', async () => {
    subjectMock.mockReturnValue({
      subject: null,
      error: NextResponse.json({ error: 'subject' }, { status: 404 }),
    });
    const response = await POST(request({
      lintJobId: 'lint-1',
      findingIds: [FINDING_ID],
      action: 'fix',
      subjectId: 'missing',
    }));

    expect(response.status).toBe(404);
    expect(remediateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['非法 action', { lintJobId: 'lint-1', findingIds: [FINDING_ID], action: 'review-source' }],
    ['缺少 action', { lintJobId: 'lint-1', findingIds: [FINDING_ID] }],
    ['lintJobId 空白', { lintJobId: '   ', findingIds: [FINDING_ID], action: 'fix' }],
    ['findingIds 非数组', { lintJobId: 'lint-1', findingIds: FINDING_ID, action: 'fix' }],
    ['findingIds 含非字符串', { lintJobId: 'lint-1', findingIds: [FINDING_ID, 1], action: 'fix' }],
  ] as const)('严格参数提取：%s → 400 且不调用 service', async (_label, body) => {
    const response = await POST(request({ ...body, subjectId: 's1' }));

    expect(response.status).toBe(400);
    expect(remediateMock).not.toHaveBeenCalled();
  });

  it('未知异常记录日志并返回不泄漏细节的稳定 500', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    remediateMock.mockRejectedValue(new Error('database password leaked'));

    const response = await POST(request({
      lintJobId: 'lint-1',
      findingIds: [FINDING_ID],
      action: 'fix',
      subjectId: 's1',
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Health remediation failed',
      code: 'internal-error',
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[health-remediation] request failed',
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
