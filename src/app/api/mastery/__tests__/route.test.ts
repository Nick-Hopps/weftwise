import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockResolve = vi.fn();
const mockListForSubject = vi.fn();
const mockListForPage = vi.fn();
const mockGetAllPages = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/middleware/user', () => ({ resolveUserId: () => 'local' }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/evidence-repo', () => ({
  listForSubject: (...a: unknown[]) => mockListForSubject(...a),
  listForPage: (...a: unknown[]) => mockListForPage(...a),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({
  getAllPages: (...a: unknown[]) => mockGetAllPages(...a),
  isMetaPage: (p: { tags?: string[] }) => (p.tags ?? []).includes('meta'),
}));

import { GET } from '../route';

function call(url = 'http://localhost/api/mastery') {
  return GET(new NextRequest(url));
}

/** 一条 strong 正证据 → mastered/high。 */
const gradedCorrect = (createdAt: string) => ({
  kind: 'quiz-correct',
  polarity: 'positive',
  strength: 'strong',
  anchor: 'q1',
  createdAt,
});

const now = () => new Date().toISOString();

beforeEach(() => {
  mockResolve.mockReset().mockReturnValue({ subject: { id: 's1', slug: 'ml' }, error: null });
  mockListForSubject.mockReset().mockReturnValue(new Map());
  mockListForPage.mockReset().mockReturnValue([]);
  mockGetAllPages.mockReset().mockReturnValue([
    { slug: 'backprop', tags: [] },
    { slug: 'index', tags: ['meta'] },
    { slug: 'log', tags: ['meta'] },
  ]);
});

describe('GET /api/mastery —— 全量', () => {
  it('空库返回 {}（冷启动零回归，下游按全 unknown 处理）', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).masteryBySlug).toEqual({});
  });

  it('逐页派生，且不含 recent（响应体不随使用量线性膨胀）', async () => {
    mockListForSubject.mockReturnValue(new Map([['backprop', [gradedCorrect(now())]]]));
    const body = await (await call()).json();

    expect(body.masteryBySlug.backprop).toMatchObject({
      state: 'mastered',
      confidence: 'high',
      evidenceCount: 1,
    });
    expect(body.masteryBySlug.backprop).not.toHaveProperty('recent');
    expect(body.masteryBySlug.backprop.expiresAt).toEqual(expect.any(String));
  });

  it('排除 meta 页，与 /api/graph 同口径', async () => {
    mockListForSubject.mockReturnValue(
      new Map([
        ['backprop', [gradedCorrect(now())]],
        ['index', [gradedCorrect(now())]],
      ]),
    );
    const body = await (await call()).json();
    expect(Object.keys(body.masteryBySlug)).toEqual(['backprop']);
  });

  it('证据指向已不存在的页时不返回（调用方 join 页面时本就会丢弃）', async () => {
    mockListForSubject.mockReturnValue(new Map([['ghost', [gradedCorrect(now())]]]));
    expect((await (await call()).json()).masteryBySlug).toEqual({});
  });

  it('subject 缺失 → 透传 error，不查证据', async () => {
    mockResolve.mockReturnValue({
      subject: null,
      error: NextResponse.json({ error: 'subject required' }, { status: 400 }),
    });
    expect((await call()).status).toBe(400);
    expect(mockListForSubject).not.toHaveBeenCalled();
  });
});

describe('GET /api/mastery?slug= —— 单页', () => {
  it('返回完整 verdict 含 recent（审计面的真实交互形状）', async () => {
    mockListForPage.mockReturnValue([gradedCorrect(now())]);
    const body = await (await call('http://localhost/api/mastery?slug=backprop')).json();

    expect(body.mastery).toMatchObject({ state: 'mastered', confidence: 'high' });
    expect(body.mastery.recent).toHaveLength(1);
    expect(mockListForPage).toHaveBeenCalledWith('local', 's1', 'backprop');
    // 单页路径不该顺手把整个 subject 的证据都捞一遍
    expect(mockListForSubject).not.toHaveBeenCalled();
  });

  it('无证据的页返回 unknown/none 而非 404', async () => {
    const body = await (await call('http://localhost/api/mastery?slug=backprop')).json();
    expect(body.mastery).toMatchObject({ state: 'unknown', confidence: 'none', recent: [] });
  });

  it('不存在的页 → 404', async () => {
    expect((await call('http://localhost/api/mastery?slug=ghost')).status).toBe(404);
  });

  it('meta 页 → 404（与全量口径一致）', async () => {
    expect((await call('http://localhost/api/mastery?slug=index')).status).toBe(404);
  });
});
