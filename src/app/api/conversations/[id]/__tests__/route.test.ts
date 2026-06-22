import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGet = vi.fn();
const mockList = vi.fn();
const mockRename = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/db/repos/conversations-repo', () => ({
  getConversation: (id: unknown) => mockGet(id),
  listMessages: (id: unknown) => mockList(id),
  renameConversation: (id: unknown, t: unknown) => mockRename(id, t),
  deleteConversation: (id: unknown) => mockDelete(id),
}));

import { GET, PATCH, DELETE } from '../route';

function req(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/conversations/c1', {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}
const params = { params: Promise.resolve({ id: 'c1' }) };

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockGet.mockReset();
  mockGet.mockReturnValue({ id: 'c1', subjectId: 's1', title: 'A', createdAt: 't', updatedAt: 't' });
  mockList.mockReset();
  mockList.mockReturnValue([]);
  mockRename.mockReset();
  mockDelete.mockReset();
});

describe('GET /api/conversations/[id]', () => {
  it('返回会话 + messages', async () => {
    const res = await GET(req('GET'), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation.id).toBe('c1');
    expect(Array.isArray(body.messages)).toBe(true);
  });
  it('未知 → 404', async () => {
    mockGet.mockReturnValue(null);
    expect((await GET(req('GET'), params)).status).toBe(404);
  });
  it('跨 subject → 404', async () => {
    mockGet.mockReturnValue({ id: 'c1', subjectId: 's2', title: 'A', createdAt: 't', updatedAt: 't' });
    expect((await GET(req('GET'), params)).status).toBe(404);
  });
});

describe('PATCH /api/conversations/[id]', () => {
  it('重命名 → 200', async () => {
    const res = await PATCH(req('PATCH', { title: '新', subjectId: 's1' }), params);
    expect(res.status).toBe(200);
    expect(mockRename).toHaveBeenCalledWith('c1', '新');
  });
  it('空 title → 400，不改', async () => {
    const res = await PATCH(req('PATCH', { title: '   ', subjectId: 's1' }), params);
    expect(res.status).toBe(400);
    expect(mockRename).not.toHaveBeenCalled();
  });
  it('跨 subject → 404', async () => {
    mockGet.mockReturnValue({ id: 'c1', subjectId: 's2', title: 'A', createdAt: 't', updatedAt: 't' });
    expect((await PATCH(req('PATCH', { title: '新', subjectId: 's1' }), params)).status).toBe(404);
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/conversations/[id]', () => {
  it('删除 → 200', async () => {
    const res = await DELETE(req('DELETE', { subjectId: 's1' }), params);
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith('c1');
  });
  it('跨 subject → 404，不删', async () => {
    mockGet.mockReturnValue({ id: 'c1', subjectId: 's2', title: 'A', createdAt: 't', updatedAt: 't' });
    expect((await DELETE(req('DELETE', { subjectId: 's1' }), params)).status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
