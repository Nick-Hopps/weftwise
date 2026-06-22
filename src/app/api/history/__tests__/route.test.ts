import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolve = vi.fn();
const mockList = vi.fn();
const mockGetVaultLog = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/operations-repo', () => ({
  listForSubject: (id: unknown) => mockList(id),
}));
vi.mock('@/server/git/git-service', () => ({
  getVaultLog: () => mockGetVaultLog(),
}));

import { GET } from '../route';

function call() {
  return GET(new NextRequest('http://localhost/api/history?subjectId=s1'));
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockList.mockReset();
  mockGetVaultLog.mockReset();
  mockGetVaultLog.mockResolvedValue([]);
});

describe('GET /api/history', () => {
  it('返回合成后的 HistoryEntry[]', async () => {
    mockList.mockReturnValue([
      { id: 'opA', jobId: 'j', subjectId: 's1', preHead: 'pre', postHead: 'shaA',
        changesetJson: JSON.stringify([{ action: 'update', path: 'wiki/general/a.md', content: '# A' }]),
        status: 'applied', jobType: 'ingest' },
    ]);
    mockGetVaultLog.mockResolvedValue([{ sha: 'shaA', date: '2026-06-22T00:00:00Z', message: '[subject:general] 摄入' }]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('opA');
    expect(body[0].type).toBe('ingest');
    expect(body[0].date).toBe('2026-06-22T00:00:00Z');
    expect(body[0].affectedPages).toEqual([{ slug: 'a', action: 'update' }]);
  });

  it('subject 缺失 → 透传 resolve 的 error 响应', async () => {
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'subject required' }, { status: 400 }) });
    const res = await call();
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
