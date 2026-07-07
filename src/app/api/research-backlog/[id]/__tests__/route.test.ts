import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolve = vi.fn();
const mockGetById = vi.fn();
const mockUpdateStatus = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/research-backlog-repo', () => ({
  getById: (...a: unknown[]) => mockGetById(...a),
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
}));

import { PATCH } from '../route';

function call(id: string, body: unknown) {
  const req = new NextRequest('http://localhost/api/research-backlog/' + id, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockGetById.mockReset();
  mockUpdateStatus.mockReset();
});

describe('PATCH /api/research-backlog/[id]', () => {
  it('更新状态并回填 researchJobId', async () => {
    mockGetById.mockReturnValue({ id: 'r1', subjectId: 's1', status: 'open' });
    mockUpdateStatus.mockReturnValue({ id: 'r1', subjectId: 's1', status: 'researched', researchJobId: 'job-1' });
    const res = await call('r1', { status: 'researched', researchJobId: 'job-1' });
    expect(res.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith('r1', 'researched', 'job-1');
    expect((await res.json()).entry.status).toBe('researched');
  });

  it('dismiss 不传 researchJobId', async () => {
    mockGetById.mockReturnValue({ id: 'r1', subjectId: 's1', status: 'open' });
    mockUpdateStatus.mockReturnValue({ id: 'r1', subjectId: 's1', status: 'dismissed' });
    await call('r1', { status: 'dismissed' });
    expect(mockUpdateStatus).toHaveBeenCalledWith('r1', 'dismissed', undefined);
  });

  it('无效 status → 400', async () => {
    const res = await call('r1', { status: 'bogus' });
    expect(res.status).toBe(400);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('条目不存在 → 404', async () => {
    mockGetById.mockReturnValue(null);
    const res = await call('missing', { status: 'dismissed' });
    expect(res.status).toBe(404);
  });

  it('条目属于其他 subject → 404', async () => {
    mockGetById.mockReturnValue({ id: 'r1', subjectId: 'other', status: 'open' });
    const res = await call('r1', { status: 'dismissed' });
    expect(res.status).toBe(404);
  });

  it('subject 缺失 → 透传 error', async () => {
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'x' }, { status: 400 }) });
    const res = await call('r1', { status: 'dismissed' });
    expect(res.status).toBe(400);
  });
});
