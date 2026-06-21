import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { serializeWikiDocument } from '@/server/wiki/markdown';
import type { WikiDocument } from '@/lib/contracts';

const mockGetPage = vi.fn();
const mockBacklinks = vi.fn();
const mockReadPage = vi.fn();
const mockResolve = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (request: unknown, options?: unknown) => mockResolve(request, options),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: (subjectId: unknown, slug: unknown) => mockGetPage(subjectId, slug),
  getBacklinks: (subjectId: unknown, slug: unknown) => mockBacklinks(subjectId, slug),
  findPageBySlugAcrossSubjects: (slug: unknown) => [],
}));
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: (subjectSlug: unknown, slug: unknown) => mockReadPage(subjectSlug, slug),
}));

import { GET } from '../route';

function call(slug: string[]) {
  const req = new NextRequest(`http://localhost/api/pages/${slug.join('/')}`);
  return GET(req, { params: Promise.resolve({ slug }) });
}

const DOC: WikiDocument = {
  frontmatter: {
    title: 'Vector Spaces',
    created: '2026-01-01',
    updated: '2026-01-02',
    tags: ['math'],
    sources: [],
  },
  body: 'A **vector space** is a set with vectors.',
  links: [],
};

beforeEach(() => {
  mockGetPage.mockReset();
  mockBacklinks.mockReset();
  mockBacklinks.mockReturnValue([]);
  mockReadPage.mockReset();
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
});

describe('GET /api/pages/[...slug]', () => {
  it('页面存在时响应含 raw = serializeWikiDocument(doc)', async () => {
    mockGetPage.mockReturnValue({ slug: 'vector-spaces', title: 'Vector Spaces', tags: ['math'], createdAt: '2026-01-01', updatedAt: '2026-01-02' });
    mockReadPage.mockReturnValue(DOC);
    const res = await call(['vector-spaces']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBe(serializeWikiDocument(DOC));
    expect(body.content).toBe(DOC.body);
  });

  it('页面不存在时仍返回 404（行为不变）', async () => {
    mockGetPage.mockReturnValue(null);
    const res = await call(['missing']);
    expect(res.status).toBe(404);
  });

  it('页面存在但 doc 为 null 时 raw 为空串', async () => {
    mockGetPage.mockReturnValue({ slug: 'x', title: 'X', tags: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' });
    mockReadPage.mockReturnValue(null);
    const res = await call(['x']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBe('');
  });
});
