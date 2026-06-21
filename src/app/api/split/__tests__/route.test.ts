import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetPage = vi.fn();
const mockResolve = vi.fn();
const mockEnqueue = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (request: unknown, options?: unknown) => mockResolve(request, options),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: (subjectId: unknown, slug: unknown) => mockGetPage(subjectId, slug),
}));
vi.mock('@/server/jobs/queue', () => ({
  enqueue: (type: unknown, params: unknown, subjectId: unknown) => mockEnqueue(type, params, subjectId),
}));

import { POST } from '../route';

function call(body: unknown) {
  const req = new NextRequest('http://localhost/api/split', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(req);
}

beforeEach(() => {
  mockGetPage.mockReset();
  mockGetPage.mockImplementation((_s: unknown, slug: unknown) => (slug === 'missing' ? null : { slug }));
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockEnqueue.mockReset();
  mockEnqueue.mockReturnValue({ id: 'job-1' });
});

describe('POST /api/split', () => {
  it('合法请求入队 split 并返回 202 + jobId', async () => {
    const res = await call({ sourceSlug: 'big', hint: 'by topic', subjectId: 's1' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBe('job-1');
    expect(mockEnqueue).toHaveBeenCalledWith('split', { sourceSlug: 'big', hint: 'by topic', subjectId: 's1' }, 's1');
  });

  it('source 不存在 → 404，不入队', async () => {
    const res = await call({ sourceSlug: 'missing', subjectId: 's1' });
    expect(res.status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('meta 系统页（index）→ 400，不入队', async () => {
    const res = await call({ sourceSlug: 'index', subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('body 缺 sourceSlug → 400，不入队', async () => {
    const res = await call({ subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
