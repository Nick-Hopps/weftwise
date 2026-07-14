import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted 确保变量在 vi.mock 工厂函数提升前已初始化
const {
  mockGenerateTools,
  mockBuildToolContext,
  mockCreateAccessedPages,
  mockCompileToolSet,
  mockGenerateStructured,
  mockBacklogCreate,
  mockExtractCitations,
  mockStreamTools,
} = vi.hoisted(() => ({
  mockGenerateTools: vi.fn(),
  mockBuildToolContext: vi.fn(() => ({})),
  mockCreateAccessedPages: vi.fn(() => ({ meta: new Map(), bodies: new Map() })),
  mockCompileToolSet: vi.fn(() => ({})),
  mockGenerateStructured: vi.fn(),
  mockBacklogCreate: vi.fn(),
  mockExtractCitations: vi.fn(() => [] as { pageSlug: string; excerpt: string }[]),
  mockStreamTools: vi.fn(),
}));

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
vi.mock('@/server/db/repos/settings-repo', () => ({
  getWikiLanguage: () => 'English',
  getWebSearchConfig: () => ({ provider: 'tavily', apiKey: '', maxResults: 5 }),
}));
vi.mock('@/server/llm/provider-registry', () => ({
  generateStructuredOutput: mockGenerateStructured,
  streamTextResponse: vi.fn(),
  streamTextWithTools: mockStreamTools,
  generateTextWithTools: mockGenerateTools,
}));
vi.mock('../query-tools', () => ({
  buildQueryToolContext: mockBuildToolContext,
  createAccessedPages: mockCreateAccessedPages,
  accessedToContext: vi.fn(() => []),
}));
vi.mock('../citation-extract', () => ({
  extractCitationsFromAnswer: mockExtractCitations,
}));
vi.mock('@/server/agents/tools/builtin', () => ({
  createBuiltinToolRegistry: () => ({
    resolve: () => [],
  }),
}));
vi.mock('@/server/agents/tools/compile', () => ({
  compileToolSet: mockCompileToolSet,
}));
vi.mock('@/server/db/repos/research-backlog-repo', () => ({
  create: mockBacklogCreate,
}));

import {
  runQuery,
  streamAgenticQuery,
  recordCoverageGap,
  NO_QUERY_CONTEXT_ANSWER,
} from '../query-service';

const SUBJECT = {
  id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard' as const, createdAt: 't', updatedAt: 't',
};

/** 异步 coverage 判定是 fire-and-forget（.then/.catch），需 flush 微任务队列后再断言。 */
async function flushPromises(times = 4) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  mockGenerateTools.mockReset();
  mockCreateAccessedPages.mockReset().mockReturnValue({ meta: new Map(), bodies: new Map() });
  mockGenerateStructured.mockReset().mockResolvedValue({ coverageSufficient: true });
  mockBacklogCreate.mockReset();
  mockExtractCitations.mockReset().mockReturnValue([]);
  mockStreamTools.mockReset().mockReturnValue({ textStream: {} });
});

describe('runQuery（agentic）', () => {
  it('active Subject 为空仍进入工具循环，以允许跨主题检索', async () => {
    mockGenerateTools.mockResolvedValue({ text: '跨主题答案 [[notes:page]]' });
    const res = await runQuery('问题', SUBJECT);
    expect(res.answer).toBe('跨主题答案 [[notes:page]]');
    expect(mockGenerateTools).toHaveBeenCalledTimes(1);
  });

  it('有内容 → 走 generateTextWithTools，返回其 text', async () => {
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    const res = await runQuery('问题', SUBJECT);
    expect(mockGenerateTools).toHaveBeenCalledTimes(1);
    expect(res.answer).toBe('答案正文');
  });

  it('模型返回空文本 → 回落 NO_CONTENT', async () => {
    mockGenerateTools.mockResolvedValue({ text: '   ' });
    const res = await runQuery('问题', SUBJECT);
    expect(res.answer).toBe(NO_QUERY_CONTEXT_ANSWER);
  });

  it('工具/模型调用失败 → 原样抛出，不伪装为空答案，也不解析引用或评估 coverage', async () => {
    const failure = new Error('tool execution failed');
    mockGenerateTools.mockRejectedValue(failure);

    await expect(runQuery('问题', SUBJECT)).rejects.toBe(failure);

    expect(mockExtractCitations).not.toHaveBeenCalled();
    expect(mockGenerateStructured).not.toHaveBeenCalled();
    expect(mockBacklogCreate).not.toHaveBeenCalled();
  });

  it('citations 来自答案内联 wikilink 的确定性解析，不再有第二次结构化输出产出 citations', async () => {
    mockGenerateTools.mockResolvedValue({ text: '答案 [[sqlite]]。' });
    mockExtractCitations.mockReturnValue([{ pageSlug: 'sqlite', excerpt: 'WAL 相关摘录' }]);
    mockGenerateStructured.mockResolvedValue({ coverageSufficient: true });

    const res = await runQuery('WAL 是什么', SUBJECT);

    expect(res.citations.map((c) => c.pageSlug)).toEqual(['sqlite']);
    expect(mockExtractCitations).toHaveBeenCalledWith('答案 [[sqlite]]。', expect.anything(), SUBJECT.slug);
    // coverage 判定异步跑在 generateStructuredOutput 上，但不再有专门产出 citations 的结构化输出调用
    await flushPromises();
    expect(mockGenerateStructured).toHaveBeenCalledTimes(1);
  });
});

describe('streamAgenticQuery - 动态工具模式', () => {
  it('propose 模式编译审批预览 profile，并把会话上下文注入工具', () => {
    const onPendingAction = vi.fn();

    streamAgenticQuery({
      question: '删除旧页面',
      subject: SUBJECT,
      mode: 'propose',
      conversationId: 'conversation-1',
      onPendingAction,
    });

    expect(mockBuildToolContext).toHaveBeenCalledWith(
      SUBJECT,
      expect.anything(),
      { conversationId: 'conversation-1', onPendingAction },
    );
    expect(mockCompileToolSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        policy: expect.objectContaining({ profileId: 'query:propose' }),
      }),
    );
  });
});

describe('runQuery — coverage gap → research backlog（异步）', () => {
  it('coverageSufficient=false → create 恰一次，question 取 suggestedResearchQuestion', async () => {
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    mockGenerateStructured.mockResolvedValue({
      coverageSufficient: false,
      suggestedResearchQuestion: '建议的研究问题',
    });
    await runQuery('原始问题', SUBJECT);
    await flushPromises();
    expect(mockBacklogCreate).toHaveBeenCalledTimes(1);
    expect(mockBacklogCreate).toHaveBeenCalledWith(SUBJECT.id, '建议的研究问题', 'ask-ai');
  });

  it('coverageSufficient=false 且无 suggestedResearchQuestion → 回落用户原问题', async () => {
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    mockGenerateStructured.mockResolvedValue({
      coverageSufficient: false,
    });
    await runQuery('原始问题', SUBJECT);
    await flushPromises();
    expect(mockBacklogCreate).toHaveBeenCalledTimes(1);
    expect(mockBacklogCreate).toHaveBeenCalledWith(SUBJECT.id, '原始问题', 'ask-ai');
  });

  it('active Subject 为空且模型仍无答案 → 异步 coverage 判定记录 gap', async () => {
    mockGenerateTools.mockResolvedValue({ text: '   ' });
    mockGenerateStructured.mockResolvedValue({ coverageSufficient: false });
    const res = await runQuery('原始问题', SUBJECT);
    expect(res.answer).toBe(NO_QUERY_CONTEXT_ANSWER);
    await flushPromises();
    expect(mockBacklogCreate).toHaveBeenCalledTimes(1);
    expect(mockBacklogCreate).toHaveBeenCalledWith(SUBJECT.id, '原始问题', 'ask-ai');
  });

  it('coverageSufficient=true → 不写 backlog', async () => {
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    mockGenerateStructured.mockResolvedValue({
      coverageSufficient: true,
    });
    await runQuery('原始问题', SUBJECT);
    await flushPromises();
    expect(mockBacklogCreate).not.toHaveBeenCalled();
  });

  it('coverage 判定抛错 → 不影响 runQuery 返回值，只 console.error', async () => {
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    mockGenerateStructured.mockRejectedValue(new Error('llm 超时'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await runQuery('原始问题', SUBJECT);
    expect(res.answer).toBe('答案正文');
    await flushPromises();
    expect(errSpy).toHaveBeenCalled();
    expect(mockBacklogCreate).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});

describe('recordCoverageGap（best-effort 吞错）', () => {
  it('repo create 抛错 → 不抛出，只记日志', () => {
    mockBacklogCreate.mockImplementation(() => {
      throw new Error('FOREIGN KEY constraint failed');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => recordCoverageGap(SUBJECT, '问题')).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
