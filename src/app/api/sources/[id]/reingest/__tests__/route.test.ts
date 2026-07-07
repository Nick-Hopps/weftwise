import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGetSource = vi.fn();
const mockListUnreferenced = vi.fn();
const mockFindJob = vi.fn();
const mockRequeue = vi.fn();
const mockEnqueue = vi.fn();
const mockEmit = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
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
  requeue: (...a: unknown[]) => mockRequeue(...a),
  enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));
vi.mock('@/server/jobs/events', () => ({ emit: (...a: unknown[]) => mockEmit(...a) }));

import { POST } from '../route';

const SUBJECT = { id: 's1', slug: 'general' };
const SOURCE = { id: 'src1', subjectId: 's1', filename: 'a.md', contentHash: 'h', parsedAt: null, metadataJson: '{}' };

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/sources/${id}/reingest`, { method: 'POST' });
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockReturnValue({ subject: SUBJECT, error: null });
  mockGetSource.mockReturnValue(SOURCE);
  mockListUnreferenced.mockReturnValue([SOURCE]);
  mockFindJob.mockReturnValue(null);
  mockEnqueue.mockReturnValue({ id: 'new-job' });
});

describe('POST /api/sources/[id]/reingest', () => {
  it('source 不存在 → 404', async () => {
    mockGetSource.mockReturnValue(null);
    expect((await call('missing')).status).toBe(404);
  });

  it('source 属其他 subject → 404', async () => {
    mockGetSource.mockReturnValue({ ...SOURCE, subjectId: 'other' });
    expect((await call('src1')).status).toBe(404);
  });

  it('已被页面引用 → 409 already-referenced', async () => {
    mockListUnreferenced.mockReturnValue([]);
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already-referenced');
  });

  it('同源 job 在途（pending/running）→ 409 in-flight', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'running', resultJson: null });
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('in-flight');
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('有 failed job → requeue 原 job（checkpoint 续传），202 回原 jobId', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: null });
    const res = await call('src1');
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('j1');
    expect(mockRequeue).toHaveBeenCalledWith('j1');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('failed job 已被用户终结（cancelled）→ 不 requeue，新建 ingest job', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: JSON.stringify({ cancelled: true }) });
    const res = await call('src1');
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('new-job');
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledWith(
      'ingest',
      { sourceId: 'src1', filename: 'a.md', subjectId: 's1' },
      's1',
    );
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
});
