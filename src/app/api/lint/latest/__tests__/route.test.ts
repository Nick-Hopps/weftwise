import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockList = vi.fn();
const mockResolve = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/jobs/queue', () => ({ list: (...a: unknown[]) => mockList(...a) }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...a: unknown[]) => mockResolve(...a),
}));

import { GET } from '../route';

function call(qs = '') {
  return GET(new NextRequest(`http://localhost/api/lint/latest${qs}`));
}

function lintJob(over: Record<string, unknown> = {}) {
  return {
    id: 'j',
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    resultJson: JSON.stringify({ findings: [] }),
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockResolve.mockReset();
});

describe('GET /api/lint/latest', () => {
  it('subject-scoped：解析 subject 后按 subjectId 查询并返回最近 findings', async () => {
    mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
    mockList.mockReturnValue([
      lintJob({
        id: 'latest',
        createdAt: '2026-05-01T00:00:00.000Z',
        resultJson: JSON.stringify({
          findings: [
            { type: 'orphan', severity: 'warning', pageSlug: 'p', description: 'd', suggestedFix: null, subjectId: 's1', subjectSlug: 'general' },
          ],
        }),
      }),
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockList).toHaveBeenCalledWith({ type: 'lint', status: 'completed', subjectId: 's1' });
    expect(body.jobId).toBe('latest');
    expect(body.bySeverity).toEqual({ critical: 0, warning: 1, info: 0 });
  });

  it('allSubjects=1：不解析 subject，只查全量 lint job 并过滤 subjectId 为 null 的', async () => {
    mockList.mockReturnValue([
      lintJob({ id: 'scoped', subjectId: 's1' }),
      lintJob({ id: 'global', subjectId: null, createdAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    const res = await call('?allSubjects=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledWith({ type: 'lint', status: 'completed' });
    expect(body.jobId).toBe('global');
  });

  it('subject 解析失败时直接回传 error 响应', async () => {
    const { NextResponse } = await import('next/server');
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'x' }, { status: 404 }) });
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });
});
