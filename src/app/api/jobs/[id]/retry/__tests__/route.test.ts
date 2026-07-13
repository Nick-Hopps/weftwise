import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGet = vi.fn();
const mockRequeue = vi.fn();
const mockEmit = vi.fn();
const mockGetSource = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: () => null,
  requireCsrf: () => null,
}));
vi.mock('@/server/jobs/queue', () => ({
  get: (...args: Parameters<typeof mockGet>) => mockGet(...args),
  requeue: (...args: Parameters<typeof mockRequeue>) => mockRequeue(...args),
}));
vi.mock('@/server/jobs/events', () => ({
  emit: (...args: Parameters<typeof mockEmit>) => mockEmit(...args),
}));
vi.mock('@/server/db/repos/sources-repo', () => ({
  getSource: (...args: Parameters<typeof mockGetSource>) => mockGetSource(...args),
}));

import { POST } from '../route';

function call() {
  const req = new NextRequest('http://localhost/api/jobs/j1/retry', { method: 'POST' });
  return POST(req, { params: Promise.resolve({ id: 'j1' }) });
}

beforeEach(() => {
  mockGet.mockReset();
  mockRequeue.mockReset();
  mockEmit.mockReset();
  mockGetSource.mockReset();
});

describe('POST /api/jobs/[id]/retry', () => {
  it('404 当 job 不存在', async () => {
    mockGet.mockReturnValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('422 当 job 非 ingest', async () => {
    mockGet.mockReturnValue({ id: 'j1', type: 'lint', status: 'failed' });
    const res = await call();
    expect(res.status).toBe(422);
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('409 当 job 状态非 failed', async () => {
    mockGet.mockReturnValue({ id: 'j1', type: 'ingest', status: 'running' });
    const res = await call();
    expect(res.status).toBe(409);
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('409 当 job 已被用户手动终结（result.cancelled=true），不可重试', async () => {
    mockGet.mockReturnValue({
      id: 'j1', type: 'ingest', status: 'failed',
      resultJson: JSON.stringify({ cancelled: true, error: { message: 'x' } }),
    });
    const res = await call();
    expect(res.status).toBe(409);
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('202 + requeue + emit job:retrying 当 failed ingest', async () => {
    mockGet
      .mockReturnValueOnce({ id: 'j1', type: 'ingest', status: 'failed' })
      .mockReturnValueOnce({ id: 'j1', type: 'ingest', status: 'pending' });
    const res = await call();
    expect(res.status).toBe(202);
    expect(mockRequeue).toHaveBeenCalledWith('j1');
    expect(mockEmit).toHaveBeenCalledWith('j1', 'job:retrying', expect.any(String), expect.objectContaining({ manual: true }));
  });

  it('409 当 job 引用的 source 已被删除（如经 Health 页 Delete source），不 requeue', async () => {
    mockGet.mockReturnValue({
      id: 'j1', type: 'ingest', status: 'failed',
      paramsJson: JSON.stringify({ sourceId: 's1', filename: 'a.md', subjectId: 'sub1' }),
    });
    mockGetSource.mockReturnValue(null);
    const res = await call();
    expect(res.status).toBe(409);
    expect(mockGetSource).toHaveBeenCalledWith('s1');
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('202 当 job 引用的 source 仍存在', async () => {
    mockGet
      .mockReturnValueOnce({
        id: 'j1', type: 'ingest', status: 'failed',
        paramsJson: JSON.stringify({ sourceId: 's1', filename: 'a.md', subjectId: 'sub1' }),
      })
      .mockReturnValueOnce({ id: 'j1', type: 'ingest', status: 'pending' });
    mockGetSource.mockReturnValue({ id: 's1', subjectId: 'sub1', filename: 'a.md' });
    const res = await call();
    expect(res.status).toBe(202);
    expect(mockRequeue).toHaveBeenCalledWith('j1');
  });

  it('409 当 failed Ingest 携带 Research provenance，禁止手动复活 delivery', async () => {
    mockGet.mockReturnValue({
      id: 'j1', type: 'ingest', status: 'failed',
      paramsJson: JSON.stringify({
        sourceId: 's1', filename: 'a.md', subjectId: 'sub1',
        researchProvenance: {
          runId: 'run-1', approvalId: 'approval-1', candidateId: 'candidate-1',
        },
      }),
    });

    const res = await call();

    expect(res.status).toBe(409);
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockGetSource).not.toHaveBeenCalled();
  });
});
