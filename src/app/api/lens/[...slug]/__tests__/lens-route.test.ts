import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const subject = {
  id: 's1', slug: 'general', name: 'G', description: '', augmentationLevel: 'standard', createdAt: '', updatedAt: '',
};

const auth = vi.fn();
const csrf = vi.fn();
vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...args: unknown[]) => auth(...args),
  requireCsrf: (...args: unknown[]) => csrf(...args),
}));
vi.mock('@/server/middleware/user', () => ({ resolveUserId: () => 'local' }));
vi.mock('@/server/middleware/subject', () => ({ resolveSubjectFromRequest: () => ({ subject, error: null }) }));
vi.mock('@/server/db/repos/pages-repo', () => ({ getPageBySlug: () => ({ slug: 'a', title: 'A' }) }));
vi.mock('@/server/wiki/wiki-store', () => ({ readPageInSubject: () => ({ body: '原文 [[Alpha]]' }) }));
vi.mock('@/server/db/repos/profiles-repo', () => ({
  getProfileOrDefault: () => ({ stylePrefs: {}, version: 2, backgroundSummary: '' }),
}));

const getLatest = vi.fn();
const replace = vi.fn();
vi.mock('@/server/db/repos/renditions-repo', () => ({
  getLatestRendition: (...args: unknown[]) => getLatest(...args),
  replaceRendition: (...args: unknown[]) => replace(...args),
}));

const isConfigured = vi.fn();
vi.mock('@/server/llm/provider-registry', () => ({ isReshapeConfigured: () => isConfigured() }));

const reshape = vi.fn();
vi.mock('@/server/services/reshape-service', () => ({ reshapePageBody: (...args: unknown[]) => reshape(...args) }));

const params = { slug: ['a'] };
const getReq = () => new NextRequest('http://x/api/lens/a');
const postReq = () => new NextRequest('http://x/api/lens/a?subjectId=s1', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockReturnValue(null);
  csrf.mockReturnValue(null);
  isConfigured.mockReturnValue(true);
});

describe('GET /api/lens/[...slug]', () => {
  it('只读取已保存版本，不调用模型，并标记是否过期', async () => {
    getLatest.mockReturnValue({ renderedMd: '保存版', canonicalHash: 'old', profileVersion: 1 });
    const { GET } = await import('../route');
    const response = await GET(getReq(), { params: Promise.resolve(params) } as never);
    expect(await response.json()).toEqual({ renderedMd: '保存版', source: 'saved', stale: true });
    expect(reshape).not.toHaveBeenCalled();
  });

  it('没有保存版本时回显 canonical，不调用模型', async () => {
    getLatest.mockReturnValue(null);
    const { GET } = await import('../route');
    const response = await GET(getReq(), { params: Promise.resolve(params) } as never);
    expect(await response.json()).toEqual({ renderedMd: '原文 [[Alpha]]', source: 'canonical', stale: false });
    expect(reshape).not.toHaveBeenCalled();
  });
});

describe('POST /api/lens/[...slug]', () => {
  it('每次强制生成并把 Markdown 与图片一起持久化', async () => {
    reshape.mockResolvedValue({
      body: '新版 ![](/api/rendition-assets/img-1)', model: null,
      assets: [{ id: 'img-1', mediaType: 'image/png', dataBase64: 'AQ==' }],
    });
    const { POST } = await import('../route');
    const response = await POST(postReq(), { params: Promise.resolve(params) } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      renderedMd: '新版 ![](/api/rendition-assets/img-1)', source: 'generated', stale: false,
    });
    expect(csrf).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({
      subjectId: 's1', slug: 'a', renderedMd: expect.stringContaining('新版'),
      assets: [{ id: 'img-1', mediaType: 'image/png', dataBase64: 'AQ==' }],
    }));
  });

  it('生成失败时不覆盖旧版本', async () => {
    reshape.mockRejectedValue(new Error('model failed'));
    const { POST } = await import('../route');
    const response = await POST(postReq(), { params: Promise.resolve(params) } as never);
    expect(response.status).toBe(502);
    expect(replace).not.toHaveBeenCalled();
  });
});
