import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const queueMock = vi.hoisted(() => ({ enqueue: vi.fn() }));
const authMock = vi.hoisted(() => vi.fn());
const csrfMock = vi.hoisted(() => vi.fn());
const subjectMock = vi.hoisted(() => vi.fn());
const verificationMock = vi.hoisted(() => ({ resolve: vi.fn() }));
const MockLintVerificationError = vi.hoisted(() => class LintVerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LintVerificationError';
  }
});

vi.mock('@/server/jobs/queue', () => queueMock);
vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...args: unknown[]) => authMock(...args),
  requireCsrf: (...args: unknown[]) => csrfMock(...args),
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => subjectMock(...args),
}));
vi.mock('@/server/services/lint-verification', () => ({
  LintVerificationError: MockLintVerificationError,
  resolveLintVerificationContext: (...args: unknown[]) => verificationMock.resolve(...args),
}));

import { POST } from '../route';

const SUBJECT = {
  id: 'subject-1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
};

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/lint', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockReturnValue(null);
  csrfMock.mockReturnValue(null);
  subjectMock.mockReturnValue({ subject: SUBJECT, error: null });
  queueMock.enqueue.mockReturnValue({ id: 'lint-next' });
});

describe('POST /api/lint', () => {
  it('普通请求保持 discovery 模式', async () => {
    const body = { subjectId: SUBJECT.id };
    const req = request(body);
    const response = await POST(req);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobId: 'lint-next',
      mode: 'discovery',
    });
    expect(queueMock.enqueue).toHaveBeenCalledWith(
      'lint',
      { subjectId: SUBJECT.id },
      SUBJECT.id,
    );
    expect(verificationMock.resolve).not.toHaveBeenCalled();
  });

  it('修后验证先校验 job 关联，再把验证上下文写入 lint params', async () => {
    const verification = {
      baselineLintJobId: 'lint-origin',
      remediationJobId: 'fix-1',
    };
    const response = await POST(request({ subjectId: SUBJECT.id, verification }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mode: 'verification' });
    expect(verificationMock.resolve).toHaveBeenCalledWith(SUBJECT.id, verification);
    expect(queueMock.enqueue).toHaveBeenCalledWith(
      'lint',
      { subjectId: SUBJECT.id, verification },
      SUBJECT.id,
    );
  });

  it('拒绝缺字段的 verification 与 all-subjects verification', async () => {
    const invalid = await POST(request({
      subjectId: SUBJECT.id,
      verification: { baselineLintJobId: 'lint-origin' },
    }));
    expect(invalid.status).toBe(400);

    const allSubjects = await POST(request({
      allSubjects: true,
      verification: { baselineLintJobId: 'lint-origin', remediationJobId: 'fix-1' },
    }));
    expect(allSubjects.status).toBe(400);
    expect(queueMock.enqueue).not.toHaveBeenCalled();
  });

  it('关联过期时返回稳定 409，不入队', async () => {
    verificationMock.resolve.mockImplementation(() => {
      throw new MockLintVerificationError('verification-context-mismatch', 'stale verification');
    });

    const response = await POST(request({
      subjectId: SUBJECT.id,
      verification: { baselineLintJobId: 'lint-origin', remediationJobId: 'fix-1' },
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'stale verification',
      code: 'verification-context-mismatch',
    });
    expect(queueMock.enqueue).not.toHaveBeenCalled();
  });
});
