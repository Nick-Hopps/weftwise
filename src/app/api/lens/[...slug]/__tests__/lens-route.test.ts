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

const appendEvidence = vi.fn();
const listForSubject = vi.fn();
vi.mock('@/server/db/repos/evidence-repo', () => ({
  appendEvidence: (...args: unknown[]) => appendEvidence(...args),
  listForSubject: (...args: unknown[]) => listForSubject(...args),
}));

const buildKnownConcepts = vi.fn();
vi.mock('@/server/profile/concept-map-io', () => ({
  buildKnownConceptsForPage: (...args: unknown[]) => buildKnownConcepts(...args),
  loadSubjectEvidence: () => new Map(),
}));

const params = { slug: ['a'] };
const getReq = () => new NextRequest('http://x/api/lens/a');
const postReq = () => new NextRequest('http://x/api/lens/a?subjectId=s1', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockReturnValue(null);
  csrf.mockReturnValue(null);
  isConfigured.mockReturnValue(true);
  buildKnownConcepts.mockReturnValue({
    concepts: { mastered: [], exposed: [], struggling: [] },
    omitted: 0,
  });
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
    expect(await response.json()).toMatchObject({
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

describe('POST /api/lens/[...slug] —— D4 重塑请求证据', () => {
  it('生成成功后追加一条 reshape-request', async () => {
    reshape.mockResolvedValue({ body: '重塑版', model: 'm', assets: [] });
    const { POST } = await import('../route');
    const response = await POST(postReq(), { params: Promise.resolve(params) } as never);

    expect(response.status).toBe(200);
    expect(appendEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'local',
        subjectId: 's1',
        slug: 'a',
        kind: 'reshape-request',
      }),
    );
  });

  it('证据写入抛错时主响应不变（best-effort，不阻断已生成的重塑版）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reshape.mockResolvedValue({ body: '重塑版', model: 'm', assets: [] });
    appendEvidence.mockImplementation(() => { throw new Error('db locked'); });

    const { POST } = await import('../route');
    const response = await POST(postReq(), { params: Promise.resolve(params) } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ renderedMd: '重塑版', source: 'generated', stale: false });
  });

  it('生成失败时不记证据（没发生的事不该留痕）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reshape.mockRejectedValue(new Error('model down'));
    const { POST } = await import('../route');
    const response = await POST(postReq(), { params: Promise.resolve(params) } as never);

    expect(response.status).toBe(502);
    expect(appendEvidence).not.toHaveBeenCalled();
  });
});

describe('POST /api/lens/[...slug] —— 已知概念地图注入（E）', () => {
  const withMastered = () => {
    buildKnownConcepts.mockReturnValue({
      concepts: {
        mastered: [{ slug: 'gradient-descent', title: 'GD', state: 'mastered' }],
        exposed: [{ slug: 'chain-rule', title: 'CR', state: 'exposed' }],
        struggling: [{ slug: 'backprop', title: 'BP', state: 'struggling' }],
      },
      omitted: 0,
    });
  };

  it('把渲染后的地图传给 reshapePageBody', async () => {
    withMastered();
    reshape.mockResolvedValue({ body: '重塑版', model: 'm', assets: [] });
    const { POST } = await import('../route');
    await POST(postReq(), { params: Promise.resolve(params) } as never);

    const passed = reshape.mock.calls[0][0] as { knownConcepts: string | null };
    expect(passed.knownConcepts).toContain('[[gradient-descent]]');
    expect(passed.knownConcepts).toContain('EXACTLY the slug');
  });

  it('三段全空时传 null —— 零证据下 prompt 与改动前逐字节相同', () => {
    reshape.mockResolvedValue({ body: '重塑版', model: 'm', assets: [] });
    return import('../route')
      .then(({ POST }) => POST(postReq(), { params: Promise.resolve(params) } as never))
      .then(() => {
        expect((reshape.mock.calls[0][0] as { knownConcepts: string | null }).knownConcepts).toBeNull();
      });
  });

  it('assumedKnown 只含 mastered 段 —— 只有它们被明确告知「不必重讲」', async () => {
    withMastered();
    reshape.mockResolvedValue({ body: '重塑版', model: 'm', assets: [] });
    const { POST } = await import('../route');
    const body = await (await POST(postReq(), { params: Promise.resolve(params) } as never)).json();

    expect(body.assumedKnown).toEqual(['gradient-descent']);
  });

  it('地图计算抛错时按「无地图」继续，重塑仍成功', async () => {
    // 重塑本身比地图重要，不该因为算不出地图就让读者拿不到重塑版。
    vi.spyOn(console, 'error').mockImplementation(() => {});
    buildKnownConcepts.mockImplementation(() => { throw new Error('boom'); });
    reshape.mockResolvedValue({ body: '重塑版', model: 'm', assets: [] });

    const { POST } = await import('../route');
    const response = await POST(postReq(), { params: Promise.resolve(params) } as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.renderedMd).toBe('重塑版');
    expect(body.assumedKnown).toEqual([]);
    expect((reshape.mock.calls[0][0] as { knownConcepts: string | null }).knownConcepts).toBeNull();
  });
});
