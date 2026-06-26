import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const subject = {
  id: 's1',
  slug: 'general',
  name: 'G',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '',
  updatedAt: '',
};

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/user', () => ({ resolveUserId: () => 'local', LOCAL_USER_ID: 'local' }));
vi.mock('@/server/middleware/subject', () => ({ resolveSubjectFromRequest: () => ({ subject, error: null }) }));
vi.mock('@/server/db/repos/pages-repo', () => ({ getPageBySlug: () => ({ slug: 'a', title: 'A' }) }));
vi.mock('@/server/wiki/wiki-store', () => ({ readPageInSubject: () => ({ body: '原文 [[Alpha]]' }) }));
vi.mock('@/server/db/repos/profiles-repo', () => ({
  getProfileOrDefault: () => ({ stylePrefs: {}, version: 2, backgroundSummary: '' }),
}));

const getRendition = vi.fn();
const upsertRendition = vi.fn();
vi.mock('@/server/db/repos/renditions-repo', () => ({
  getRendition: (...a: unknown[]) => getRendition(...a),
  upsertRendition: (...a: unknown[]) => upsertRendition(...a),
}));

const isConfigured = vi.fn();
vi.mock('@/server/llm/provider-registry', () => ({ isReshapeConfigured: () => isConfigured() }));

const reshape = vi.fn();
vi.mock('@/server/services/reshape-service', () => ({ reshapePageBody: (...a: unknown[]) => reshape(...a) }));

const req = () => new NextRequest('http://x/api/lens/a');
const params = { slug: ['a'] };

beforeEach(() => {
  getRendition.mockReset();
  upsertRendition.mockReset();
  isConfigured.mockReset();
  reshape.mockReset();
});

describe('GET /api/lens/[...slug]', () => {
  it('缓存命中 → source=cache，不调 reshape', async () => {
    getRendition.mockReturnValue('缓存重塑');
    const { GET } = await import('../route');
    const r = await GET(req(), { params: Promise.resolve(params) } as never);
    expect(await r.json()).toEqual({ renderedMd: '缓存重塑', source: 'cache' });
    expect(reshape).not.toHaveBeenCalled();
  });

  it('未配置 reshape → 回落 canonical', async () => {
    getRendition.mockReturnValue(null);
    isConfigured.mockReturnValue(false);
    const { GET } = await import('../route');
    const r = await GET(req(), { params: Promise.resolve(params) } as never);
    expect(await r.json()).toEqual({ renderedMd: '原文 [[Alpha]]', source: 'canonical' });
  });

  it('生成成功 → 缓存 + source=generated', async () => {
    getRendition.mockReturnValue(null);
    isConfigured.mockReturnValue(true);
    reshape.mockResolvedValue({ body: '重塑版', fallback: false, model: null });
    const { GET } = await import('../route');
    const r = await GET(req(), { params: Promise.resolve(params) } as never);
    expect(await r.json()).toEqual({ renderedMd: '重塑版', source: 'generated' });
    expect(upsertRendition).toHaveBeenCalledOnce();
  });

  it('保真 fallback → 回落 canonical，不缓存', async () => {
    getRendition.mockReturnValue(null);
    isConfigured.mockReturnValue(true);
    reshape.mockResolvedValue({ body: '原文 [[Alpha]]', fallback: true, model: null });
    const { GET } = await import('../route');
    const r = await GET(req(), { params: Promise.resolve(params) } as never);
    expect(await r.json()).toEqual({ renderedMd: '原文 [[Alpha]]', source: 'fallback' });
    expect(upsertRendition).not.toHaveBeenCalled();
  });
});
