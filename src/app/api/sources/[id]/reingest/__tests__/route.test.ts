import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireAuth = vi.fn();
const mockRequireCsrf = vi.fn();
const mockResolve = vi.fn();
const mockGetSource = vi.fn();
const mockListUnreferenced = vi.fn();
const mockFindJob = vi.fn();
const mockRequeueWithParams = vi.fn();
const mockEnqueue = vi.fn();
const mockEmit = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...a: unknown[]) => mockRequireAuth(...a),
  requireCsrf: (...a: unknown[]) => mockRequireCsrf(...a),
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...a: unknown[]) => mockResolve(...a),
}));
vi.mock('@/server/db/repos/sources-repo', () => ({
  getSource: (...a: unknown[]) => mockGetSource(...a),
  listUnreferencedSources: (...a: unknown[]) => mockListUnreferenced(...a),
}));
vi.mock('@/server/db/repos/jobs-repo', () => ({
  findLatestIngestJobForSource: (...a: unknown[]) => mockFindJob(...a),
}));
vi.mock('@/server/jobs/queue', () => ({
  requeueJobWithParams: (...a: unknown[]) => mockRequeueWithParams(...a),
  enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));
vi.mock('@/server/jobs/events', () => ({ emit: (...a: unknown[]) => mockEmit(...a) }));

import { reingestOrphanSource } from '@/server/services/source-reingest';
import { POST } from '../route';

const SUBJECT = { id: 's1', slug: 'general' };
const SOURCE = { id: 'src1', subjectId: 's1', filename: 'a.md', contentHash: 'h', parsedAt: null, metadataJson: '{}' };

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/sources/${id}/reingest`, { method: 'POST' });
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockReturnValue(null);
  mockRequireCsrf.mockReturnValue(null);
  mockResolve.mockReturnValue({ subject: SUBJECT, error: null });
  mockGetSource.mockReturnValue(SOURCE);
  mockListUnreferenced.mockReturnValue([SOURCE]);
  mockFindJob.mockReturnValue(null);
  mockRequeueWithParams.mockReturnValue({ id: 'j1' });
  mockEnqueue.mockReturnValue({ id: 'new-job' });
});

describe('POST /api/sources/[id]/reingest', () => {
  it('source 不存在 → 404', async () => {
    mockGetSource.mockReturnValue(null);
    const response = await call('missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'source-not-found' });
    expect(mockRequeueWithParams).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('source 属其他 subject → 404', async () => {
    mockGetSource.mockReturnValue({ ...SOURCE, subjectId: 'other' });
    expect((await call('src1')).status).toBe(404);
    expect(mockRequeueWithParams).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('已被页面引用 → 409 already-referenced', async () => {
    mockListUnreferenced.mockReturnValue([]);
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already-referenced');
    expect(mockRequeueWithParams).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('同源 job 在途（pending/running）→ 409 in-flight', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'running', resultJson: null });
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('in-flight');
    expect(mockRequeueWithParams).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('有 failed job → requeue 原 job（checkpoint 续传），202 回原 jobId', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: null });
    const res = await call('src1');
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('j1');
    expect(mockRequeueWithParams).toHaveBeenCalledWith('j1', {});
    expect(mockEmit).toHaveBeenCalledWith(
      'j1',
      'job:retrying',
      'Manual re-ingest — resuming from checkpoint',
      { manual: true },
    );
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('failed job 原子重排冲突 → 409 requeue-conflict，且不新建 job', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: null });
    mockRequeueWithParams.mockReturnValue(null);
    const res = await call('src1');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'requeue-conflict' });
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('failed job 已被用户终结（cancelled）→ 不 requeue，新建 ingest job', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: JSON.stringify({ cancelled: true }) });
    const res = await call('src1');
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('new-job');
    expect(mockRequeueWithParams).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledWith(
      'ingest',
      { sourceId: 'src1', filename: 'a.md', subjectId: 's1' },
      's1',
    );
  });

  it('failed job result 损坏时按普通失败处理并原子重排', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: '{' });
    const res = await call('src1');

    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('j1');
    expect(mockRequeueWithParams).toHaveBeenCalledWith('j1', {});
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('查无 job / job completed → 新建 ingest job，202 回新 jobId', async () => {
    const res = await call('src1');
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('new-job');
    expect(mockEnqueue).toHaveBeenCalledWith(
      'ingest',
      { sourceId: 'src1', filename: 'a.md', subjectId: 's1' },
      's1',
    );

    mockEnqueue.mockClear();
    mockFindJob.mockReturnValue({ id: 'j1', status: 'completed', resultJson: null });
    const res2 = await call('src1');
    expect(res2.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalled();
  });

  it('helper 原子重排时把 remediationContext 合并进原 job 参数', () => {
    const remediationContext = {
      lintJobId: 'lint-1',
      findingIds: ['a'.repeat(64)],
      action: 're-ingest' as const,
    };
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: null });

    expect(reingestOrphanSource({
      subjectId: 's1',
      sourceId: 'src1',
      remediationContext,
    })).toEqual({ jobId: 'j1' });
    expect(mockRequeueWithParams).toHaveBeenCalledWith('j1', { remediationContext });
  });

  it('helper 新建 ingest 时也携带 remediationContext', () => {
    const remediationContext = {
      lintJobId: 'lint-1',
      findingIds: ['a'.repeat(64)],
      action: 're-ingest' as const,
    };

    expect(reingestOrphanSource({
      subjectId: 's1',
      sourceId: 'src1',
      remediationContext,
    })).toEqual({ jobId: 'new-job' });
    expect(mockEnqueue).toHaveBeenCalledWith(
      'ingest',
      {
        sourceId: 'src1',
        filename: 'a.md',
        subjectId: 's1',
        remediationContext,
      },
      's1',
    );
  });

  it('Auth、CSRF、subject 失败都不调用 helper 依赖', async () => {
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
    expect(mockRequeueWithParams).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
