import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockHasContent = vi.fn();
const mockAgentic = vi.fn();
const mockAccessedToContext = vi.fn();
const mockExtractCitations = vi.fn();
const mockRecordCoverageGap = vi.fn();
const mockAssessCoverage = vi.fn();
const mockResolveQueryMode = vi.fn();
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
  runQuery: vi.fn(),
  recordCoverageGap: (...a: unknown[]) => mockRecordCoverageGap(...a),
  assessCoverageInBackground: (...a: unknown[]) => mockAssessCoverage(...a),
  NO_QUERY_CONTEXT_ANSWER: 'NO_CONTEXT',
}));
vi.mock('@/server/services/citation-extract', () => ({
  extractCitationsFromAnswer: (...a: unknown[]) => mockExtractCitations(...a),
}));
vi.mock('@/server/services/query-intent', () => ({
  resolveQueryMode: (...a: unknown[]) => mockResolveQueryMode(...a),
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
        yield { type: 'text-delta', text: 'hello' } as const;
      })(),
    },
    accessed: { meta: new Map(), bodies: new Map() },
  });
  mockAccessedToContext.mockReset();
  mockAccessedToContext.mockReturnValue([]);
  mockExtractCitations.mockReset();
  mockExtractCitations.mockReturnValue([]);
  mockRecordCoverageGap.mockReset();
  mockAssessCoverage.mockReset();
  mockResolveQueryMode.mockReset().mockImplementation((question: string) =>
    question.includes('删除') ? 'propose' : 'read',
  );
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
    expect(mockRecordCoverageGap).toHaveBeenCalledWith(
      { id: 's1', slug: 'general' },
      '随便问问',
    );
    expect(mockAssessCoverage).not.toHaveBeenCalled();
    expect(mockExtractCitations).not.toHaveBeenCalled();
  });

  it('工具循环路径 → 透传 answer-delta，citations 来自确定性解析，done 不带 coverageSufficient', async () => {
    mockExtractCitations.mockReturnValue([{ pageSlug: 'foo', excerpt: 'bar' }]);
    const res = await call({ question: '你好', subjectId: 's1' });
    const sse = await readSSE(res);
    expect(mockAgentic).toHaveBeenCalledTimes(1);
    expect(sse).toContain('hello');
    expect(mockExtractCitations).toHaveBeenCalledWith('hello', expect.anything(), 'general');
    expect(sse).toContain('event: citations');
    expect(sse).toContain('"pageSlug":"foo"');

    const doneEventBlock = sse.slice(sse.indexOf('event: done'));
    expect(doneEventBlock).not.toContain('coverageSufficient');

    expect(mockAssessCoverage).toHaveBeenCalledTimes(1);
    expect(mockAssessCoverage).toHaveBeenCalledWith(
      { id: 's1', slug: 'general' },
      '你好',
      'hello',
    );
    expect(mockAgentic).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'read',
      conversationId: 'new-conv',
    }));
  });

  it('明确写入意图 → 传 propose 模式并推送 pending-action 事件', async () => {
    const action = {
      actionId: 'a1',
      conversationId: 'new-conv',
      operation: 'delete',
      status: 'pending',
    };
    mockAgentic.mockImplementation((opts: unknown) => {
      const onPendingAction = (opts as { onPendingAction?: (value: unknown) => void }).onPendingAction;
      onPendingAction?.(action);
      return {
        stream: {
          fullStream: (async function* () {
            yield { type: 'text-delta', text: '请审批' } as const;
          })(),
        },
        accessed: { meta: new Map(), bodies: new Map() },
      };
    });

    const res = await call({ question: '删除旧页面', subjectId: 's1' });
    const sse = await readSSE(res);

    expect(mockAgentic).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'propose',
      conversationId: 'new-conv',
      onPendingAction: expect.any(Function),
    }));
    expect(sse).toContain('event: pending-action');
    expect(sse).toContain(`data: ${JSON.stringify(action)}`);
  });
});
