import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockHasContent = vi.fn();
const mockAgentic = vi.fn();
const mockAccessedToContext = vi.fn();
const mockCitations = vi.fn();
const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockListMsgs = vi.fn();
const mockAppend = vi.fn();
const mockTouch = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/jobs/queue', () => ({ enqueue: vi.fn(() => ({ id: 'job-x' })) }));
vi.mock('@/server/services/query-service', () => ({
  streamAgenticQuery: (...a: unknown[]) => mockAgentic(...a),
  subjectHasContent: (...a: unknown[]) => mockHasContent(...a),
  accessedToContext: (...a: unknown[]) => mockAccessedToContext(...a),
  generateQueryCitations: (...a: unknown[]) => mockCitations(...a),
  runQuery: vi.fn(),
  recordCoverageGap: vi.fn(),
  NO_QUERY_CONTEXT_ANSWER: 'NO_CONTEXT',
}));
vi.mock('@/server/services/conversation-title', () => ({
  deriveConversationTitle: (q: string) => `T:${q.slice(0, 5)}`,
}));
vi.mock('@/server/db/repos/conversations-repo', () => ({
  createConversation: (s: unknown, t: unknown) => mockCreate(s, t),
  getConversation: (id: unknown) => mockGet(id),
  listMessages: (id: unknown) => mockListMsgs(id),
  appendMessage: (...a: unknown[]) => mockAppend(...a),
  touchConversation: (id: unknown) => mockTouch(id),
}));

import { POST } from '../route';

function call(body: unknown) {
  return POST(new NextRequest('http://localhost/api/query', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

async function readSSE(res: Response): Promise<string> {
  return await new Response(res.body).text();
}

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockHasContent.mockReset();
  mockHasContent.mockReturnValue(true);
  mockAgentic.mockReset();
  mockAgentic.mockReturnValue({
    stream: {
      fullStream: (async function* () {
        yield { type: 'text-delta', textDelta: 'hello' } as const;
      })(),
    },
    accessed: { meta: new Map(), bodies: new Map() },
  });
  mockAccessedToContext.mockReset();
  mockAccessedToContext.mockReturnValue([]);
  mockCitations.mockReset();
  mockCitations.mockResolvedValue([]);
  mockCreate.mockReset();
  mockCreate.mockImplementation((s: string) => ({ id: 'new-conv', subjectId: s, title: 'T', createdAt: 't', updatedAt: 't' }));
  mockGet.mockReset();
  mockListMsgs.mockReset();
  mockListMsgs.mockReturnValue([]);
  mockAppend.mockReset();
  mockTouch.mockReset();
});

describe('POST /api/query 流式持久化', () => {
  it('无 conversationId → 创建会话，done 回传新 id，落库 user+assistant', async () => {
    const res = await call({ question: '你好世界', subjectId: 's1' });
    const sse = await readSSE(res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(sse).toContain('event: done');
    expect(sse).toContain('new-conv');
    expect(mockAppend).toHaveBeenCalledTimes(2);
    expect(mockTouch).toHaveBeenCalledWith('new-conv');
  });

  it('传跨 subject 的 conversationId → 当作新会话（create 被调）', async () => {
    mockGet.mockReturnValue({ id: 'c-other', subjectId: 's2', title: 'X', createdAt: 't', updatedAt: 't' });
    const res = await call({ question: '问题', subjectId: 's1', conversationId: 'c-other' });
    await readSSE(res);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalled();
  });

  it('有效同 subject conversationId → 不创建，载历史，done 回传该 id', async () => {
    mockGet.mockReturnValue({ id: 'c1', subjectId: 's1', title: 'A', createdAt: 't', updatedAt: 't' });
    const res = await call({ question: '追问', subjectId: 's1', conversationId: 'c1' });
    const sse = await readSSE(res);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockListMsgs).toHaveBeenCalledWith('c1');
    expect(sse).toContain('c1');
    expect(mockTouch).toHaveBeenCalledWith('c1');
  });

  it('空 subject → 直接 NO_CONTENT，不进工具循环', async () => {
    mockHasContent.mockReturnValue(false);
    const res = await call({ question: '随便问问', subjectId: 's1' });
    const sse = await readSSE(res);
    expect(mockAgentic).not.toHaveBeenCalled();
    expect(sse).toContain('NO_CONTEXT');
    expect(sse).toContain('event: done');
    expect(mockAppend).toHaveBeenCalledTimes(2); // 仍落库一轮
  });

  it('工具循环路径 → 透传 answer-delta，最终 done', async () => {
    const res = await call({ question: '你好', subjectId: 's1' });
    const sse = await readSSE(res);
    expect(mockAgentic).toHaveBeenCalledTimes(1);
    expect(sse).toContain('hello');
    expect(sse).toContain('event: done');
  });
});
