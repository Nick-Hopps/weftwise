import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockAuth = vi.fn();
const mockCsrf = vi.fn();
const mockResolve = vi.fn();
const mockCreate = vi.fn();
const mockList = vi.fn();

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
    createTagBatchPendingActionPreview: (...args: unknown[]) => mockCreate(...args),
    listTagBatchPendingActions: (...args: unknown[]) => mockList(...args),
  };
});

import { GET, POST } from '../route';

const subject = { id: 's1', slug: 'general' };

function getRequest() {
  return new NextRequest('http://localhost/api/tag-actions?subjectId=s1');
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/tag-actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuth.mockReturnValue(null);
  mockCsrf.mockReturnValue(null);
  mockResolve.mockReturnValue({ subject, error: null });
  mockList.mockReturnValue([{ actionId: 'a1', operation: 'tag-batch', status: 'pending' }]);
  mockCreate.mockResolvedValue({ actionId: 'a1', operation: 'tag-batch', status: 'pending' });
});

describe('GET /api/tag-actions', () => {
  it('按显式 Subject 返回工作台审批列表', async () => {
    const response = GET(getRequest());
    expect(mockAuth).toHaveBeenCalledOnce();
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), { required: true });
    expect(mockList).toHaveBeenCalledWith({ subject });
    expect(await response.json()).toEqual({
      actions: [{ actionId: 'a1', operation: 'tag-batch', status: 'pending' }],
    });
  });
});

describe('POST /api/tag-actions', () => {
  it('鉴权、CSRF 与 Subject 解析后创建规范化的服务端预览', async () => {
    const body = {
      subjectId: 's1', action: 'merge', sourceTag: ' old ', targetTag: ' canonical ',
    };
    const response = await POST(postRequest(body));

    expect(response.status).toBe(201);
    expect(mockAuth).toHaveBeenCalledOnce();
    expect(mockCsrf).toHaveBeenCalledOnce();
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), { required: true, body });
    expect(mockCreate).toHaveBeenCalledWith({
      subject,
      payload: { action: 'merge', sourceTag: 'old', targetTag: 'canonical' },
    });
  });

  it('拒绝 action 与 target 不匹配的请求，不创建审批', async () => {
    const response = await POST(postRequest({
      subjectId: 's1', action: 'delete', sourceTag: 'old', targetTag: 'unexpected',
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_TAG_ACTION');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('Subject 解析失败时透传响应', async () => {
    mockResolve.mockReturnValue({
      subject: null,
      error: NextResponse.json({ error: 'subject required' }, { status: 400 }),
    });
    expect((await POST(postRequest({ action: 'delete', sourceTag: 'old' }))).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
