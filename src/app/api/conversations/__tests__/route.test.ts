import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolve = vi.fn();
const mockList = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/conversations-repo', () => ({
  listConversations: (id: unknown) => mockList(id),
}));

import { GET } from '../route';

function call() {
  return GET(new NextRequest('http://localhost/api/conversations?subjectId=s1'));
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockList.mockReset();
});

describe('GET /api/conversations', () => {
  it('返回本 subject 会话列表', async () => {
    mockList.mockReturnValue([{ id: 'c1', subjectId: 's1', title: 'A', createdAt: 't', updatedAt: 't' }]);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json())[0].id).toBe('c1');
    expect(mockList).toHaveBeenCalledWith('s1');
  });

  it('subject 缺失 → 透传 error，不查 repo', async () => {
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'x' }, { status: 400 }) });
    expect((await call()).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
