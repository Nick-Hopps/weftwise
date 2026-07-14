import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockAgentic = vi.fn();
const mockAccessedToContext = vi.fn();
const mockExtractCitations = vi.fn();
const mockAssessCoverage = vi.fn();
const mockResolveQueryMode = vi.fn();
const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockListMsgs = vi.fn();
const mockAppend = vi.fn();
const mockTouch = vi.fn();
const mockEnqueue = vi.fn();
const mockRunQuery = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (req: unknown, opts?: unknown) => mockResolve(req, opts),
}));
vi.mock('@/server/jobs/queue', () => ({ enqueue: (...a: unknown[]) => mockEnqueue(...a) }));
vi.mock('@/server/services/query-service', () => ({
  streamAgenticQuery: (...a: unknown[]) => mockAgentic(...a),
  accessedToContext: (...a: unknown[]) => mockAccessedToContext(...a),
  runQuery: (...a: unknown[]) => mockRunQuery(...a),
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
  mockEnqueue.mockReset().mockReturnValue({ id: 'job-x' });
  mockRunQuery.mockReset();
});

describe('POST /api/query 保存到 Wiki', () => {
  it('已有回答 save-only → 仅入队 subject-scoped job，并返回 202/jobId', async () => {
    const citations = [{ pageSlug: 'page-a', excerpt: 'Excerpt A' }];

    const res = await call({
      saveAsPage: true,
      pageTitle: 'Saved Answer',
      answer: 'Answer body',
      citations,
      subjectId: 's1',
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      jobId: 'job-x',
      answer: 'Answer body',
      citations,
      subjectId: 's1',
    });
    expect(mockEnqueue).toHaveBeenCalledWith(
      'save-to-wiki',
      {
        answer: 'Answer body',
        title: 'Saved Answer',
        citations,
        subjectId: 's1',
      },
      's1',
    );
    expect(mockRunQuery).not.toHaveBeenCalled();
    expect(mockAgentic).not.toHaveBeenCalled();
  });

  it('question + saveAsPage → 用生成的 answer/citations 入队并返回 saveJobId', async () => {
    const citations = [{ pageSlug: 'page-b', excerpt: 'Excerpt B' }];
    mockRunQuery.mockResolvedValue({
      answer: 'Generated answer',
      citations,
      savedAsPage: null,
    });

    const res = await call({
      question: 'Generate an answer',
      saveAsPage: true,
      pageTitle: 'Generated Page',
      subjectId: 's1',
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      answer: 'Generated answer',
      citations,
      saveJobId: 'job-x',
      subjectId: 's1',
    });
    expect(mockRunQuery).toHaveBeenCalledWith(
      'Generate an answer',
      { id: 's1', slug: 'general' },
      undefined,
    );
    expect(mockEnqueue).toHaveBeenCalledWith(
      'save-to-wiki',
      {
        answer: 'Generated answer',
        title: 'Generated Page',
        citations,
        subjectId: 's1',
      },
      's1',
    );
  });

  it('save-only 缺 answer 且缺 question → 400，不入队', async () => {
    const res = await call({ saveAsPage: true, pageTitle: 'Incomplete', subjectId: 's1' });

    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
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

  it('active Subject 为空仍进入工具循环，以允许跨主题检索', async () => {
    const res = await call({ question: '随便问问', subjectId: 's1' });
    const sse = await readSSE(res);
    expect(mockAgentic).toHaveBeenCalledTimes(1);
    expect(sse).toContain('hello');
    expect(sse).toContain('event: done');
    expect(mockAppend).toHaveBeenCalledTimes(2); // 仍落库一轮
    expect(mockAssessCoverage).toHaveBeenCalled();
    expect(mockExtractCitations).toHaveBeenCalled();
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
