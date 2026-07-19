import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  summarizeUsage: vi.fn((options?: unknown) => {
    void options;
    return [];
  }),
  getSubject: vi.fn(),
}));

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/db/repos/usage-repo', () => ({
  summarizeUsage: (options: unknown) => mocks.summarizeUsage(options),
}));
vi.mock('@/server/db/repos/subjects-repo', () => ({
  getById: (id: unknown) => mocks.getSubject(id),
}));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSubject.mockImplementation((id: string) => id === 's1' ? { id: 's1' } : null);
});

describe('GET /api/usage', () => {
  it('把有效 subjectId 与时间窗口传给 repo', async () => {
    const response = await GET(new NextRequest('http://localhost/api/usage?window=7d&subjectId=s1'));
    expect(response.status).toBe(200);
    expect(mocks.summarizeUsage).toHaveBeenCalledWith({
      sinceMs: expect.any(Number),
      subjectId: 's1',
    });
    expect((await response.json()).subjectId).toBe('s1');
  });

  it('缺省 subjectId 时查询全部项目', async () => {
    await GET(new NextRequest('http://localhost/api/usage?window=all'));
    expect(mocks.getSubject).not.toHaveBeenCalled();
    expect(mocks.summarizeUsage).toHaveBeenCalledWith({ sinceMs: undefined });
  });

  it('未知 subjectId 返回 400 且不查用量', async () => {
    const response = await GET(new NextRequest('http://localhost/api/usage?subjectId=missing'));
    expect(response.status).toBe(400);
    expect(mocks.summarizeUsage).not.toHaveBeenCalled();
  });
});
