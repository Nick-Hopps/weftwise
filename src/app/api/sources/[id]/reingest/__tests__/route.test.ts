import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { Job } from '@/lib/contracts';

const mockRequireAuth = vi.fn();
const mockRequireCsrf = vi.fn();
const mockResolve = vi.fn();
const mockGetSource = vi.fn();
const mockListUnreferenced = vi.fn();
const mockReingestAtomic = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  requireCsrf: (...args: unknown[]) => mockRequireCsrf(...args),
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mockResolve(...args),
}));
vi.mock('@/server/db/repos/sources-repo', () => ({
  getSource: (...args: unknown[]) => mockGetSource(...args),
  listUnreferencedSources: (...args: unknown[]) => mockListUnreferenced(...args),
}));
vi.mock('@/server/jobs/queue', () => ({
  reingestSourceAtomic: (...args: unknown[]) => mockReingestAtomic(...args),
}));

import { reingestOrphanSource } from '@/server/services/source-reingest';
import { POST } from '../route';

const SUBJECT = { id: 's1', slug: 'general' };
const SOURCE = {
  id: 'src1',
  subjectId: 's1',
  filename: 'a.md',
  contentHash: 'h',
  parsedAt: null,
  metadataJson: '{}',
};
const REMEDIATION_CONTEXT = {
  lintJobId: 'lint-1',
  findingIds: ['a'.repeat(64)],
  action: 're-ingest' as const,
};

function call(id: string) {
  const request = new NextRequest(
    `http://localhost/api/sources/${id}/reingest`,
    { method: 'POST' },
  );
  return POST(request, { params: Promise.resolve({ id }) });
}

function inFlightJob(remediationContext = REMEDIATION_CONTEXT): Job {
  return {
    id: 'j1',
    type: 'ingest',
    status: 'pending',
    subjectId: 's1',
    paramsJson: JSON.stringify({
      sourceId: 'src1',
      filename: 'a.md',
      subjectId: 's1',
      remediationContext,
    }),
    resultJson: null,
    createdAt: '2026-07-13T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockReturnValue(null);
  mockRequireCsrf.mockReturnValue(null);
  mockResolve.mockReturnValue({ subject: SUBJECT, error: null });
  mockGetSource.mockReturnValue(SOURCE);
  mockListUnreferenced.mockReturnValue([SOURCE]);
  mockReingestAtomic.mockReturnValue({
    kind: 'created',
    job: { id: 'new-job' },
  });
});

describe('POST /api/sources/[id]/reingest', () => {
  it('source 不存在或跨 subject → 稳定 404 source-not-found，且不进入原子编排', async () => {
    mockGetSource.mockReturnValueOnce(null);
    const missing = await call('missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'source-not-found' });

    mockGetSource.mockReturnValueOnce({ ...SOURCE, subjectId: 'other' });
    const crossSubject = await call('src1');
    expect(crossSubject.status).toBe(404);
    expect(await crossSubject.json()).toEqual({ error: 'source-not-found' });
    expect(mockReingestAtomic).not.toHaveBeenCalled();
  });

  it('已被页面引用 → 409 already-referenced，且不进入原子编排', async () => {
    mockListUnreferenced.mockReturnValue([]);
    const response = await call('src1');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'already-referenced' });
    expect(mockReingestAtomic).not.toHaveBeenCalled();
  });

  it('专用 route 无 context 时在途任务仍返回 409 in-flight', async () => {
    mockReingestAtomic.mockReturnValue({
      kind: 'in-flight',
      job: { id: 'j1' },
      deduplicated: false,
    });
    const response = await call('src1');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'in-flight' });
  });

  it.each([
    ['requeued', 'j1'],
    ['created', 'new-job'],
  ] as const)('%s → 专用 route 仅返回 202 jobId', async (kind, jobId) => {
    mockReingestAtomic.mockReturnValue({ kind, job: { id: jobId } });
    const response = await call('src1');

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId });
  });

  it('原子编排 conflict → 409 requeue-conflict', async () => {
    mockReingestAtomic.mockReturnValue({ kind: 'conflict' });
    const response = await call('src1');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'requeue-conflict' });
  });

  it('Auth、CSRF、subject 失败都不读取 source 或进入原子编排', async () => {
    mockRequireAuth.mockReturnValueOnce(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    );
    expect((await call('src1')).status).toBe(401);

    mockRequireCsrf.mockReturnValueOnce(
      NextResponse.json({ error: 'csrf' }, { status: 403 }),
    );
    expect((await call('src1')).status).toBe(403);

    mockResolve.mockReturnValueOnce({
      subject: null,
      error: NextResponse.json({ error: 'subject' }, { status: 404 }),
    });
    expect((await call('src1')).status).toBe(404);

    expect(mockGetSource).not.toHaveBeenCalled();
    expect(mockReingestAtomic).not.toHaveBeenCalled();
  });
});

describe('reingestOrphanSource 与原子 repo 集成边界', () => {
  it('把创建参数、context patch 和同步 in-flight matcher 一次传给原子 API', () => {
    expect(reingestOrphanSource({
      subjectId: 's1',
      sourceId: 'src1',
      remediationContext: REMEDIATION_CONTEXT,
    })).toEqual({ jobId: 'new-job', deduplicated: false });

    expect(mockReingestAtomic).toHaveBeenCalledWith({
      subjectId: 's1',
      sourceId: 'src1',
      createParams: {
        sourceId: 'src1',
        filename: 'a.md',
        subjectId: 's1',
        remediationContext: REMEDIATION_CONTEXT,
      },
      paramsPatch: { remediationContext: REMEDIATION_CONTEXT },
      isDuplicateInFlight: expect.any(Function),
    });

    const matcher = mockReingestAtomic.mock.calls[0][0]
      .isDuplicateInFlight as (job: Job) => boolean;
    expect(matcher(inFlightJob())).toBe(true);
    expect(matcher(inFlightJob({ ...REMEDIATION_CONTEXT, lintJobId: 'lint-2' }))).toBe(false);
  });

  it('相同 context 的 in-flight 原子结果作为 deduplicated 返回原 job', () => {
    mockReingestAtomic.mockReturnValue({
      kind: 'in-flight',
      job: { id: 'j1' },
      deduplicated: true,
    });

    expect(reingestOrphanSource({
      subjectId: 's1',
      sourceId: 'src1',
      remediationContext: REMEDIATION_CONTEXT,
    })).toEqual({ jobId: 'j1', deduplicated: true });
  });
});
