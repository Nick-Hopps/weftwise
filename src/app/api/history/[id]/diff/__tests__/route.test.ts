import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGetById = vi.fn();
const mockGetDiff = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  getById: (id: unknown) => mockGetById(id),
}));
vi.mock('@/server/git/git-service', () => ({
  getDiff: (a: unknown, b: unknown) => mockGetDiff(a, b),
}));

import { GET } from '../route';

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/history/${id}/diff?subjectId=s1`);
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockGetById.mockReset();
  mockGetDiff.mockReset();
  mockGetDiff.mockResolvedValue('diff-text');
});

describe('GET /api/history/[id]/diff', () => {
  it('未知 op → 404', async () => {
    mockGetById.mockReturnValue(null);
    expect((await call('nope')).status).toBe(404);
  });

  it('跨 subject 的 op → 404', async () => {
    mockGetById.mockReturnValue({ id: 'opX', subjectId: 's2', preHead: 'pre', postHead: 'sha' });
    expect((await call('opX')).status).toBe(404);
    expect(mockGetDiff).not.toHaveBeenCalled();
  });

  it('合法 → 返回 diff 文本', async () => {
    mockGetById.mockReturnValue({ id: 'opA', subjectId: 's1', preHead: 'pre', postHead: 'sha' });
    const res = await call('opA');
    expect(res.status).toBe(200);
    expect((await res.json()).diff).toBe('diff-text');
    expect(mockGetDiff).toHaveBeenCalledWith('pre', 'sha');
  });
});
