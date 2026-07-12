import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { Job, LintFinding } from '@/lib/contracts';

const mockEnqueue = vi.fn();
const mockList = vi.fn();
const mockResolveSubject = vi.fn();
const mockResolveTopics = vi.fn();
const mockIsConfigured = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mockResolveSubject(...args),
}));
vi.mock('@/server/jobs/queue', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  list: (...args: unknown[]) => mockList(...args),
}));
vi.mock('@/server/search/web-search', () => ({
  isWebSearchConfigured: (...args: unknown[]) => mockIsConfigured(...args),
}));
vi.mock('@/server/services/research-service', () => ({
  resolveTopicsFromFindingIds: (...args: unknown[]) => mockResolveTopics(...args),
}));

import { findingId } from '@/server/services/finding-identity';
import { POST } from '../route';

const RAW_GAP = {
  type: 'coverage-gap',
  severity: 'info',
  pageSlug: 'grpc-streaming',
  description: 'gRPC streaming',
  suggestedFix: null,
  subjectId: 's1',
  subjectSlug: 'general',
} satisfies LintFinding & { subjectId: string; subjectSlug: string };
const RAW_SECOND_GAP = {
  type: 'coverage-gap',
  severity: 'info',
  pageSlug: 'reactive-backpressure',
  description: 'Reactive backpressure',
  suggestedFix: null,
  subjectId: 's1',
  subjectSlug: 'general',
} satisfies LintFinding & { subjectId: string; subjectSlug: string };
const GAP_ID = findingId(RAW_GAP);
const SECOND_GAP_ID = findingId(RAW_SECOND_GAP);

function req(body: unknown) {
  return new NextRequest('http://localhost/api/research', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function lintJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'lint-1',
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    paramsJson: JSON.stringify({ subjectId: 's1' }),
    resultJson: JSON.stringify({ findings: [RAW_GAP, RAW_SECOND_GAP] }),
    createdAt: '2026-07-12T10:00:00.000Z',
    startedAt: '2026-07-12T10:00:00.000Z',
    completedAt: '2026-07-12T10:00:30.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockEnqueue.mockReset();
  mockList.mockReset();
  mockResolveSubject.mockReset();
  mockResolveTopics.mockReset();
  mockIsConfigured.mockReset();
  mockResolveSubject.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockResolveTopics.mockReturnValue(['gRPC streaming']);
  mockIsConfigured.mockReturnValue(true);
  mockEnqueue.mockReturnValue({ id: 'job1' });
  mockList.mockReturnValue([lintJob()]);
});

describe('POST /api/research', () => {
  it('topic 分支：trim 后入队且不生成 remediationContext', async () => {
    const res = await POST(req({ topic: '  Rust async runtimes  ' }));
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ jobId: 'job1' });
    expect(mockEnqueue).toHaveBeenCalledWith(
      'research',
      { topic: 'Rust async runtimes', subjectId: 's1' },
      's1',
    );
    expect(mockResolveTopics).not.toHaveBeenCalled();
  });

  it('findingIds 分支：精确验证最新 lint 快照并携带规范化上下文入队', async () => {
    const res = await POST(req({
      findingIds: [SECOND_GAP_ID, GAP_ID, GAP_ID],
      lintJobId: 'lint-1',
    }));
    expect(res.status).toBe(202);
    expect(mockList).toHaveBeenCalledWith({ type: 'lint', status: 'completed', subjectId: 's1' });
    expect(mockResolveTopics).toHaveBeenCalledWith(
      's1',
      'lint-1',
      [SECOND_GAP_ID, GAP_ID, GAP_ID],
    );
    expect(mockEnqueue).toHaveBeenCalledWith(
      'research',
      {
        findingIds: [GAP_ID, SECOND_GAP_ID].sort(),
        lintJobId: 'lint-1',
        subjectId: 's1',
        remediationContext: {
          lintJobId: 'lint-1',
          findingIds: [GAP_ID, SECOND_GAP_ID].sort(),
          action: 'research',
        },
      },
      's1',
    );
  });

  it.each([
    ['数字下标', { gapIds: ['1'] }],
    ['与 topic 混用', { gapIds: null, topic: 'x' }],
  ] as const)('显式出现 gapIds（%s）无条件 400', async (_label, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'gapIds is no longer supported; use findingIds with lintJobId',
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['findingIds 与 topic 同时提供', { findingIds: [GAP_ID], lintJobId: 'lint-1', topic: 'x' }],
    ['都未提供', {}],
  ] as const)('%s → 400', async (_label, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['不是数组', { findingIds: GAP_ID, lintJobId: 'lint-1' }],
    ['空数组', { findingIds: [], lintJobId: 'lint-1' }],
    ['含非字符串', { findingIds: [GAP_ID, 1], lintJobId: 'lint-1' }],
    ['非 64 位', { findingIds: ['abc'], lintJobId: 'lint-1' }],
    ['含大写 hex', { findingIds: ['A'.repeat(64)], lintJobId: 'lint-1' }],
    ['缺 lintJobId', { findingIds: [GAP_ID] }],
  ] as const)('非法 findingIds 请求（%s）→ 400', async (_label, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockResolveTopics).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('请求 lintJobId 不是当前 subject 最新 completed 快照 → 409', async () => {
    mockList.mockReturnValue([lintJob({ id: 'lint-new' })]);
    const res = await POST(req({ findingIds: [GAP_ID], lintJobId: 'lint-old' }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Research lint snapshot is stale' });
    expect(mockResolveTopics).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('精确 resolver 拒绝缺失 ID 或非 coverage-gap → 400', async () => {
    mockResolveTopics.mockImplementation(() => {
      throw new Error('Research findingIds must reference coverage-gap findings');
    });
    const res = await POST(req({ findingIds: [GAP_ID], lintJobId: 'lint-1' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Research findingIds must reference coverage-gap findings',
    });
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
    mockResolveSubject.mockReturnValue({
      subject: null,
      error: NextResponse.json({ error: 'x' }, { status: 404 }),
    });
    const res = await POST(req({ topic: 'x' }));
    expect(res.status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
