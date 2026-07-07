import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolve = vi.fn();
const mockList = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/research-backlog-repo', () => ({
  listForSubject: (...a: unknown[]) => mockList(...a),
}));

import { GET } from '../route';

function call(url = 'http://localhost/api/research-backlog') {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockList.mockReset();
});

describe('GET /api/research-backlog', () => {
  it('返回本 subject 的全部条目（status 未传）', async () => {
    mockList.mockReturnValue([{ id: 'r1' }]);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toEqual([{ id: 'r1' }]);
    expect(mockList).toHaveBeenCalledWith('s1', undefined);
  });

  it('按 status=open 过滤', async () => {
    mockList.mockReturnValue([]);
    await call('http://localhost/api/research-backlog?status=open');
    expect(mockList).toHaveBeenCalledWith('s1', 'open');
  });

  it('无效 status 被忽略（等价未传）', async () => {
    mockList.mockReturnValue([]);
    await call('http://localhost/api/research-backlog?status=bogus');
    expect(mockList).toHaveBeenCalledWith('s1', undefined);
  });

  it('subject 缺失 → 透传 error，不查 repo', async () => {
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'x' }, { status: 400 }) });
    expect((await call()).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
