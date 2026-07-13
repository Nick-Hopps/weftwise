import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Job, LintFinding } from '@/lib/contracts';

const mockEnqueue = vi.fn();
const mockListLatestCompletedLint = vi.fn();
const mockList = vi.fn();
const mockResolveSubject = vi.fn();
const mockResolveTopics = vi.fn();
const mockIsConfigured = vi.fn();
const MockResearchScopeError = vi.hoisted(() => class ResearchScopeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ResearchScopeError';
    this.code = code;
  }
});

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mockResolveSubject(...args),
}));
vi.mock('@/server/jobs/queue', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  listLatestCompletedLint: (...args: unknown[]) => mockListLatestCompletedLint(...args),
  list: (...args: unknown[]) => mockList(...args),
}));
vi.mock('@/server/search/web-search', () => ({
  isWebSearchConfigured: (...args: unknown[]) => mockIsConfigured(...args),
}));
vi.mock('@/server/services/research-scope', () => ({
  MAX_RESEARCH_FINDING_IDS: 100,
  ResearchScopeError: MockResearchScopeError,
  resolveTopicsFromFindingIds: (...args: unknown[]) => mockResolveTopics(...args),
}));

import { findingId } from '@/server/services/finding-identity';
import { ResearchScopeError } from '@/server/services/research-scope';
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
const RAW_THIN_PAGE = {
  type: 'thin-page',
  severity: 'info',
  pageSlug: 'thin-without-sources',
  description: 'Thin page without sources',
  suggestedFix: null,
  subjectId: 's1',
  subjectSlug: 'general',
} satisfies LintFinding & { subjectId: string; subjectSlug: string };
const GAP_ID = findingId(RAW_GAP);
const SECOND_GAP_ID = findingId(RAW_SECOND_GAP);
const THIN_PAGE_ID = findingId(RAW_THIN_PAGE);
const TOO_MANY_FINDING_IDS = Array.from(
  { length: 101 },
  (_, index) => index.toString(16).padStart(64, '0'),
);

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
    resultJson: JSON.stringify({ findings: [RAW_GAP, RAW_SECOND_GAP, RAW_THIN_PAGE] }),
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
  mockListLatestCompletedLint.mockReset();
  mockList.mockReset();
  mockResolveSubject.mockReset();
  mockResolveTopics.mockReset();
  mockIsConfigured.mockReset();
  mockResolveSubject.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockResolveTopics.mockReturnValue(['gRPC streaming']);
  mockIsConfigured.mockReturnValue(true);
  mockEnqueue.mockReturnValue({ id: 'job1' });
  mockListLatestCompletedLint.mockReturnValue(lintJob());
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
    expect(mockListLatestCompletedLint).toHaveBeenCalledWith('s1');
    expect(mockList).not.toHaveBeenCalled();
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

  it('findingIds 分支允许 coverage-gap 与 thin-page 混合批次', async () => {
    const findingIds = [THIN_PAGE_ID, GAP_ID];
    const normalized = [...findingIds].sort();
    const res = await POST(req({ findingIds, lintJobId: 'lint-1' }));

    expect(res.status).toBe(202);
    expect(mockResolveTopics).toHaveBeenCalledWith('s1', 'lint-1', findingIds);
    expect(mockEnqueue).toHaveBeenCalledWith(
      'research',
      {
        findingIds: normalized,
        lintJobId: 'lint-1',
        subjectId: 's1',
        remediationContext: {
          lintJobId: 'lint-1',
          findingIds: normalized,
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
    mockListLatestCompletedLint.mockReturnValue(lintJob({ id: 'lint-new' }));
    const res = await POST(req({ findingIds: [GAP_ID], lintJobId: 'lint-old' }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Research lint snapshot is stale' });
    expect(mockResolveTopics).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('精确 resolver 拒绝缺失 ID 或非 Research finding → 400', async () => {
    mockResolveTopics.mockImplementation(() => {
      throw new ResearchScopeError(
        'invalid-finding-scope',
        'Research findingIds must reference coverage-gap or thin-page findings',
      );
    });
    const res = await POST(req({ findingIds: [GAP_ID], lintJobId: 'lint-1' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Research findingIds must reference coverage-gap or thin-page findings',
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('findingIds 超过 100 项 → 400，且不读取快照或调用 resolver', async () => {
    const res = await POST(req({ findingIds: TOO_MANY_FINDING_IDS, lintJobId: 'lint-1' }));
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockResolveTopics).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('resolver 未知异常 → 稳定 500 且不泄漏内部消息', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockResolveTopics.mockImplementation(() => {
      throw new Error('database password leaked');
    });

    const res = await POST(req({ findingIds: [GAP_ID], lintJobId: 'lint-1' }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('route 不导入会注册 worker handler 的 research-service', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/api/research/route.ts'),
      'utf8',
    );
    expect(source).not.toContain("@/server/services/research-service");
    expect(source).toContain("@/server/services/research-scope");
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
