import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockAuth = vi.fn();
const mockCsrf = vi.fn();
const mockResolve = vi.fn();
const mockGetPage = vi.fn();
const mockAppend = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...a: unknown[]) => mockAuth(...a),
  requireCsrf: (...a: unknown[]) => mockCsrf(...a),
}));
vi.mock('@/server/middleware/user', () => ({ resolveUserId: () => 'local' }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: (...a: unknown[]) => mockGetPage(...a),
}));
vi.mock('@/server/db/repos/evidence-repo', () => ({
  appendEvidence: (...a: unknown[]) => mockAppend(...a),
}));

import { POST } from '../route';

function call(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = { slug: 'backprop', kind: 'quiz-wrong', anchor: 'q1', subjectId: 's1' };

beforeEach(() => {
  mockAuth.mockReset().mockReturnValue(null);
  mockCsrf.mockReset().mockReturnValue(null);
  mockResolve.mockReset().mockReturnValue({ subject: { id: 's1', slug: 'ml' }, error: null });
  mockGetPage.mockReset().mockReturnValue({ subjectId: 's1', slug: 'backprop' });
  mockAppend.mockReset();
});

describe('POST /api/evidence', () => {
  it('鉴权失败直接返回，不落行', async () => {
    mockAuth.mockReturnValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
    expect((await call(VALID)).status).toBe(401);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('CSRF 失败直接返回，不落行', async () => {
    mockCsrf.mockReturnValue(NextResponse.json({ error: 'csrf' }, { status: 403 }));
    expect((await call(VALID)).status).toBe(403);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('subject 必填：缺失时透传 error，不落行', async () => {
    mockResolve.mockReturnValue({
      subject: null,
      error: NextResponse.json({ error: 'subject required' }, { status: 400 }),
    });
    expect((await call({ ...VALID, subjectId: undefined })).status).toBe(400);
    expect(mockAppend).not.toHaveBeenCalled();
    // required:true —— 证据必须归属到确定的 subject，不能靠 cookie 兜底猜
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ required: true }));
  });

  it('未知 kind → 400，不落行', async () => {
    expect((await call({ ...VALID, kind: 'not-a-kind' })).status).toBe(400);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('slug 不在该 subject 内 → 404，不落行', async () => {
    // 没有这条校验，陈旧客户端（页面刚被删/改名，缓存未刷新）会持续累积指向幽灵页的
    // 证据；生命周期闭合只清理「存在过的页」，兜不住从未存在过的 slug。
    mockGetPage.mockReturnValue(null);
    expect((await call(VALID)).status).toBe(404);
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockGetPage).toHaveBeenCalledWith('s1', 'backprop');
  });

  it('写入成功返回 201，权重由 kind 派生', async () => {
    const res = await call(VALID);
    expect(res.status).toBe(201);
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'local',
        subjectId: 's1',
        slug: 'backprop',
        kind: 'quiz-wrong',
        anchor: 'q1',
      }),
    );
  });

  it('quiz-correct 可带 strength 上调（揭晓后判分）', async () => {
    await call({ ...VALID, kind: 'quiz-correct', strength: 'strong' });
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ strength: 'strong' }));
  });

  it('非法 strength → 400', async () => {
    expect((await call({ ...VALID, kind: 'quiz-correct', strength: 'nuclear' })).status).toBe(400);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('detail 作为归因载荷透传（viewedSource / profileVersion）', async () => {
    await call({ ...VALID, detail: { viewedSource: 'reshape', profileVersion: 3 } });
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { viewedSource: 'reshape', profileVersion: 3 } }),
    );
  });

  it('repo 抛错 → 500，不吞异常', async () => {
    mockAppend.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect((await call(VALID)).status).toBe(500);
  });
});
