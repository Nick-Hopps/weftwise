import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockEnqueue = vi.fn();
const mockList = vi.fn();
const mockResolve = vi.fn();
const mockIsConfigured = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...a: unknown[]) => mockResolve(...a),
}));
vi.mock('@/server/jobs/queue', () => ({
  enqueue: (...a: unknown[]) => mockEnqueue(...a),
  list: (...a: unknown[]) => mockList(...a),
}));
vi.mock('@/server/search/web-search', () => ({
  isWebSearchConfigured: (...a: unknown[]) => mockIsConfigured(...a),
}));

import { POST } from '../route';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/research', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function lintJobWithCoverageGap() {
  return [
    {
      id: 'lint1',
      type: 'lint',
      status: 'completed',
      completedAt: '2026-01-01T00:00:00.000Z',
      resultJson: JSON.stringify({
        findings: [
          { type: 'broken-link', description: 'x', severity: 'warning', pageSlug: 'p', suggestedFix: null },
          { type: 'coverage-gap', description: 'gRPC streaming', severity: 'info', pageSlug: 'gRPC streaming', suggestedFix: null },
        ],
      }),
    },
  ];
}

beforeEach(() => {
  mockEnqueue.mockReset();
  mockList.mockReset();
  mockResolve.mockReset();
  mockIsConfigured.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockIsConfigured.mockReturnValue(true);
  mockEnqueue.mockReturnValue({ id: 'job1' });
});

describe('POST /api/research', () => {
  it('topic 分支：入队 research job，202 + jobId', async () => {
    const res = await POST(req({ topic: 'Rust async runtimes' }));
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.jobId).toBe('job1');
    expect(mockEnqueue).toHaveBeenCalledWith(
      'research',
      { gapIds: undefined, topic: 'Rust async runtimes', subjectId: 's1' },
      's1',
    );
  });

  it('gapIds 分支：命中最近快照的 coverage-gap → 入队', async () => {
    mockList.mockReturnValue(lintJobWithCoverageGap());
    const res = await POST(req({ gapIds: ['1'] }));
    expect(res.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith(
      'research',
      { gapIds: ['1'], topic: undefined, subjectId: 's1' },
      's1',
    );
  });

  it('gapIds 越界/不命中 coverage-gap → 400', async () => {
    mockList.mockReturnValue(lintJobWithCoverageGap());
    const res = await POST(req({ gapIds: ['99'] }));
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('gapIds 与 topic 同时提供 → 400', async () => {
    const res = await POST(req({ gapIds: ['1'], topic: 'x' }));
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('都未提供 → 400', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('web search 未配置 → 422，不入队', async () => {
    mockIsConfigured.mockReturnValue(false);
    const res = await POST(req({ topic: 'x' }));
    expect(res.status).toBe(422);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('subject 解析失败 → 直接回传 error 响应', async () => {
    const { NextResponse } = await import('next/server');
    mockResolve.mockReturnValue({ subject: null, error: NextResponse.json({ error: 'x' }, { status: 404 }) });
    const res = await POST(req({ topic: 'x' }));
    expect(res.status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
