import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockReadHistoryDiff = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/services/history-tools', () => ({
  readHistoryDiff: (...args: unknown[]) => mockReadHistoryDiff(...args),
}));

import { GET } from '../route';

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/history/${id}/diff?subjectId=s1`);
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockReadHistoryDiff.mockReset();
  mockReadHistoryDiff.mockResolvedValue({
    operationId: 'opA', status: 'applied', affectedPages: [], diff: 'diff-text',
  });
});

describe('GET /api/history/[id]/diff', () => {
  it('未知 op → 404', async () => {
    mockReadHistoryDiff.mockRejectedValue(new Error('not found'));
    expect((await call('nope')).status).toBe(404);
  });

  it('跨 subject 的 op → 404', async () => {
    mockReadHistoryDiff.mockRejectedValue(new Error('not found'));
    expect((await call('opX')).status).toBe(404);
  });

  it('合法 → 返回 diff 文本', async () => {
    const res = await call('opA');
    expect(res.status).toBe(200);
    expect((await res.json()).diff).toBe('diff-text');
    expect(mockReadHistoryDiff).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
      { operationId: 'opA' },
    );
  });
});
