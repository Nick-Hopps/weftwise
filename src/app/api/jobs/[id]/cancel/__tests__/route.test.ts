import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGet = vi.fn();
const mockRequestCancel = vi.fn();
const mockEmit = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: () => null,
  requireCsrf: () => null,
}));
vi.mock('@/server/jobs/queue', () => ({
  get: (...args: Parameters<typeof mockGet>) => mockGet(...args),
  requestCancel: (...args: Parameters<typeof mockRequestCancel>) => mockRequestCancel(...args),
}));
vi.mock('@/server/jobs/events', () => ({
  emit: (...args: Parameters<typeof mockEmit>) => mockEmit(...args),
}));

import { POST } from '../route';

function call() {
  const req = new NextRequest('http://localhost/api/jobs/j1/cancel', { method: 'POST' });
  return POST(req, { params: Promise.resolve({ id: 'j1' }) });
}

beforeEach(() => {
  mockGet.mockReset();
  mockRequestCancel.mockReset();
  mockEmit.mockReset();
});

describe('POST /api/jobs/[id]/cancel', () => {
  it('404 当 job 不存在', async () => {
    mockGet.mockReturnValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('409 当 job 已终态（requestCancel 返回 already-terminal）', async () => {
    mockGet.mockReturnValue({ id: 'j1', type: 'ingest', status: 'completed' });
    mockRequestCancel.mockReturnValue('already-terminal');
    const res = await call();
    expect(res.status).toBe(409);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('200 + requestCancel + emit job:cancelled 当成功取消', async () => {
    mockGet
      .mockReturnValueOnce({ id: 'j1', type: 'ingest', status: 'running' })
      .mockReturnValueOnce({ id: 'j1', type: 'ingest', status: 'failed' });
    mockRequestCancel.mockReturnValue('cancelled');
    const res = await call();
    expect(res.status).toBe(200);
    expect(mockRequestCancel).toHaveBeenCalledWith('j1');
    expect(mockEmit).toHaveBeenCalledWith(
      'j1',
      'job:cancelled',
      expect.any(String),
      expect.objectContaining({ manual: true }),
    );
  });
});
