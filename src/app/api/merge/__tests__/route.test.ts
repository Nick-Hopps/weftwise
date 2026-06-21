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
  const req = new NextRequest('http://localhost/api/merge', {
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

describe('POST /api/merge', () => {
  it('合法请求入队 merge 并返回 202 + jobId', async () => {
    const res = await call({ targetSlug: 'a', sourceSlug: 'b', subjectId: 's1' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBe('job-1');
    expect(mockEnqueue).toHaveBeenCalledWith('merge', { targetSlug: 'a', sourceSlug: 'b', subjectId: 's1' }, 's1');
  });

  it('target==source → 400，不入队', async () => {
    const res = await call({ targetSlug: 'a', sourceSlug: 'a', subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('source 不存在 → 404', async () => {
    const res = await call({ targetSlug: 'a', sourceSlug: 'missing', subjectId: 's1' });
    expect(res.status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('meta 系统页（index）→ 400', async () => {
    const res = await call({ targetSlug: 'index', sourceSlug: 'b', subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('body 缺字段 → 400，不入队', async () => {
    const res = await call({ targetSlug: 'a', subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('target 不存在 → 404', async () => {
    const res = await call({ targetSlug: 'missing', sourceSlug: 'b', subjectId: 's1' });
    expect(res.status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
