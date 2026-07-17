import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockAgentic = vi.fn();
const mockAccessedToContext = vi.fn();
const mockExtractCitations = vi.fn();
const mockAssessCoverage = vi.fn();
const mockResolveQueryMode = vi.fn();
const mockResolveDirectReenrichSlug = vi.fn();
const mockClassifySelectionIntent = vi.fn();
const mockCreateWorkflowPreview = vi.fn();
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
  resolveDirectReenrichSlug: (...a: unknown[]) => mockResolveDirectReenrichSlug(...a),
  classifySelectionIntent: (...a: unknown[]) => mockClassifySelectionIntent(...a),
}));
vi.mock('@/server/services/pending-action-service', () => ({
  createPendingWorkflowActionPreview: (...a: unknown[]) => mockCreateWorkflowPreview(...a),
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
  mockResolveDirectReenrichSlug.mockReset().mockReturnValue(null);
  mockClassifySelectionIntent.mockReset().mockResolvedValue('other');
  mockCreateWorkflowPreview.mockReset();
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

  it('正常空流 → 回落 NO_CONTEXT，并按成功终态持久化、发送 done、评估 coverage', async () => {
    mockAgentic.mockReturnValue({
      stream: {
        fullStream: (async function* () {
          // 无文本且无错误：属于正常空结果。
        })(),
      },
      accessed: { meta: new Map(), bodies: new Map() },
    });

    const res = await call({ question: '没有命中', subjectId: 's1' });
    const sse = await readSSE(res);

    expect(sse).toContain('event: answer-delta');
    expect(sse).toContain('NO_CONTEXT');
    expect(sse).toContain('event: citations');
    expect(sse).toContain('event: done');
    expect(sse).not.toContain('event: error');
    expect(mockExtractCitations).toHaveBeenCalledWith('NO_CONTEXT', expect.anything(), 'general');
    expect(mockAppend).toHaveBeenCalledTimes(2);
    expect(mockTouch).toHaveBeenCalledWith('new-conv');
    expect(mockAssessCoverage).toHaveBeenCalledWith(
      { id: 's1', slug: 'general' },
      '没有命中',
      'NO_CONTEXT',
    );
  });

  it('fullStream error part → 只发一次错误终态，不回落、不持久化、不评估 coverage', async () => {
    mockAgentic.mockReturnValue({
      stream: {
        fullStream: (async function* () {
          yield { type: 'tool-call', toolName: 'wiki.search', input: { query: 'x' } } as const;
          yield { type: 'error', error: new Error('tool execution failed') } as const;
        })(),
      },
      accessed: { meta: new Map(), bodies: new Map() },
    });

    const res = await call({ question: '触发工具失败', subjectId: 's1' });
    const sse = await readSSE(res);

    expect(sse.match(/event: error/g)).toHaveLength(1);
    expect(sse).toContain('tool execution failed');
    expect(sse).not.toContain('NO_CONTEXT');
    expect(sse).not.toContain('event: citations');
    expect(sse).not.toContain('event: done');
    expect(mockExtractCitations).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockAssessCoverage).not.toHaveBeenCalled();
  });

  it('fullStream 在部分文本后抛错 → 保留已发送 delta，但不把部分回答按成功终态收口', async () => {
    mockAgentic.mockReturnValue({
      stream: {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: '部分回答' } as const;
          throw new Error('stream interrupted');
        })(),
      },
      accessed: { meta: new Map(), bodies: new Map() },
    });

    const res = await call({ question: '触发流中断', subjectId: 's1' });
    const sse = await readSSE(res);

    expect(sse).toContain('部分回答');
    expect(sse.match(/event: error/g)).toHaveLength(1);
    expect(sse).toContain('stream interrupted');
    expect(sse).not.toContain('event: citations');
    expect(sse).not.toContain('event: done');
    expect(mockExtractCitations).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockAssessCoverage).not.toHaveBeenCalled();
  });

  it('streamAgenticQuery 初始化抛错 → 只发错误终态，不产生任何成功副作用', async () => {
    mockAgentic.mockImplementation(() => {
      throw new Error('stream setup failed');
    });

    const res = await call({ question: '触发初始化失败', subjectId: 's1' });
    const sse = await readSSE(res);

    expect(sse.match(/event: error/g)).toHaveLength(1);
    expect(sse).toContain('stream setup failed');
    expect(sse).not.toContain('event: answer-delta');
    expect(sse).not.toContain('event: citations');
    expect(sse).not.toContain('event: done');
    expect(mockExtractCitations).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockAssessCoverage).not.toHaveBeenCalled();
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

  it('canonical 选区的 LLM 配图意图开启专用 propose 工具', async () => {
    const selection = {
      sourceKind: 'canonical',
      quote: '选中的概念',
      section: '原理',
      blockStart: 10,
      blockEnd: 40,
    };
    mockClassifySelectionIntent.mockResolvedValue('image-insert');

    const res = await call({
      question: 'Use these excerpts as context:\n> 坐标系说明\n\nQuestion: 在这下面生成一张图片说明',
      userQuestion: '在这下面生成一张图片说明',
      pageSlug: 'page-a',
      subjectId: 's1',
      selection,
    });
    await readSSE(res);

    expect(mockClassifySelectionIntent).toHaveBeenCalledWith('在这下面生成一张图片说明');
    expect(mockAgentic).toHaveBeenCalledWith(expect.objectContaining({
      currentPageSlug: 'page-a',
      selection,
      mode: 'propose',
      imageInsertEnabled: true,
    }));
  });

  it('canonical 选区的普通问答保持 read 且不开放配图工具', async () => {
    mockClassifySelectionIntent.mockResolvedValue('other');

    const res = await call({
      question: 'Use this excerpt as context:\n> 坐标系说明\n\nQuestion: 解释一下这段内容',
      userQuestion: '解释一下这段内容',
      pageSlug: 'page-a',
      subjectId: 's1',
      selection: {
        sourceKind: 'canonical',
        quote: '坐标系说明',
        section: null,
        blockStart: 0,
        blockEnd: 20,
      },
    });
    await readSSE(res);

    expect(mockResolveQueryMode).toHaveBeenCalledWith('解释一下这段内容');
    expect(mockAgentic).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'read',
      imageInsertEnabled: false,
    }));
  });

  it('Reshape 选区配图命令确定性提示切回 Original，不调用 Query LLM', async () => {
    mockClassifySelectionIntent.mockResolvedValue('image-insert');
    const res = await call({
      question: 'Use this excerpt as context:\n> 重塑内容\n\nQuestion: 给这里画个图',
      userQuestion: '给这里画个图',
      pageSlug: 'page-a',
      subjectId: 's1',
      selection: {
        sourceKind: 'reshape',
        quote: '重塑后的概念',
        section: null,
        blockStart: 0,
        blockEnd: 20,
      },
    });
    const sse = await readSSE(res);

    expect(mockClassifySelectionIntent).toHaveBeenCalledWith('给这里画个图');
    expect(mockAgentic).not.toHaveBeenCalled();
    expect(sse).toContain('Original');
    expect(sse).toContain('event: done');
    expect(mockAppend).toHaveBeenCalledTimes(2);
  });

  it('明确 re-enrich 命令直接生成审批预览，不等待 Query LLM', async () => {
    const action = {
      actionId: 'reenrich-a1',
      conversationId: 'new-conv',
      operation: 'workflow-reenrich-start',
      status: 'pending',
    };
    mockResolveDirectReenrichSlug.mockReturnValue('page-a');
    mockCreateWorkflowPreview.mockResolvedValue(action);

    const res = await call({
      question: '重新丰富当前页面',
      pageSlug: 'page-a',
      subjectId: 's1',
    });
    const sse = await readSSE(res);

    expect(mockCreateWorkflowPreview).toHaveBeenCalledWith({
      conversationId: 'new-conv',
      subject: { id: 's1', slug: 'general' },
      input: {
        operation: 'workflow-reenrich-start',
        payload: { slug: 'page-a' },
      },
    });
    expect(mockAgentic).not.toHaveBeenCalled();
    expect(mockAssessCoverage).not.toHaveBeenCalled();
    expect(sse).toContain('event: pending-action');
    expect(sse).toContain('reenrich-a1');
    expect(sse).toContain('event: answer-delta');
    expect(sse).toContain('event: done');
    expect(mockAppend).toHaveBeenCalledTimes(2);
  });
});
