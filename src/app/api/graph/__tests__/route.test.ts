import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetAllPages = vi.fn();
const mockGetAllLinks = vi.fn();
const mockResolve = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (request: unknown) => mockResolve(request),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({
  getAllPages: (...args: unknown[]) => mockGetAllPages(...args),
  getAllLinks: (...args: unknown[]) => mockGetAllLinks(...args),
  isMetaPage: (page: { tags?: string[] }) => page.tags?.includes('meta') ?? false,
}));

import { GET } from '../route';

function link(sourceSlug: string, targetSlug: string, targetSubjectId = 's1') {
  return {
    subjectId: 's1',
    sourceSlug,
    targetSubjectId,
    targetSlug,
    context: '',
  };
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockGetAllPages.mockReset();
  mockGetAllPages.mockReturnValue([
    { subjectId: 's1', slug: 'a', title: '页面 A', tags: [] },
    { subjectId: 's1', slug: 'b', title: '页面 B', tags: [] },
    { subjectId: 's1', slug: 'c', title: '页面 C', tags: [] },
    { subjectId: 's1', slug: 'meta', title: 'Meta', tags: ['meta'] },
  ]);
  mockGetAllLinks.mockReset();
});

describe('GET /api/graph', () => {
  it('聚合同方向重复引用，并保留反向关系与原始引用计数', async () => {
    mockGetAllLinks.mockReturnValue([
      link('a', 'b'),
      link('a', 'b'),
      link('a', 'b'),
      link('c', 'b'),
      link('b', 'a'),
      link('a', 'missing'),
      link('a', 'b', 's2'),
      link('meta', 'a'),
    ]);

    const response = await GET(new NextRequest('http://localhost/api/graph?subjectId=s1'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.edges).toEqual([
      { source: 'a', target: 'b', weight: 3 },
      { source: 'c', target: 'b', weight: 1 },
      { source: 'b', target: 'a', weight: 1 },
    ]);
    expect(body.nodes).toEqual([
      { id: 'a', label: '页面 A', linkCount: 1 },
      { id: 'b', label: '页面 B', linkCount: 2 },
      { id: 'c', label: '页面 C', linkCount: 0 },
    ]);
    expect(body.meta).toMatchObject({
      nodeCount: 3,
      edgeCount: 3,
      referenceCount: 5,
    });
  });
});
