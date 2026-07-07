import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted 确保变量在 vi.mock 工厂函数提升前已初始化
const {
  mockGenerateTools,
  mockSubjectHasContent,
  mockBuildToolContext,
  mockAccessedToContext,
  mockCompileToolSet,
  mockGenerateStructured,
  mockBacklogCreate,
} = vi.hoisted(() => ({
  mockGenerateTools: vi.fn(),
  mockSubjectHasContent: vi.fn(),
  mockBuildToolContext: vi.fn(() => ({})),
  mockAccessedToContext: vi.fn(() => [] as unknown[]),
  mockCompileToolSet: vi.fn(() => ({})),
  mockGenerateStructured: vi.fn(),
  mockBacklogCreate: vi.fn(),
}));

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
vi.mock('@/server/db/repos/settings-repo', () => ({
  getWikiLanguage: () => 'English',
  getWebSearchConfig: () => ({ provider: 'tavily', apiKey: '', maxResults: 5 }),
}));
vi.mock('@/server/llm/provider-registry', () => ({
  generateStructuredOutput: mockGenerateStructured,
  streamTextResponse: vi.fn(),
  streamTextWithTools: vi.fn(),
  generateTextWithTools: mockGenerateTools,
}));
vi.mock('../query-tools', () => ({
  buildQueryToolContext: mockBuildToolContext,
  createAccessedPages: () => ({ meta: new Map(), bodies: new Map() }),
  accessedToContext: mockAccessedToContext,
  subjectHasContent: mockSubjectHasContent,
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

import { runQuery, recordCoverageGap, NO_QUERY_CONTEXT_ANSWER } from '../query-service';

const SUBJECT = {
  id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard' as const, createdAt: 't', updatedAt: 't',
};

beforeEach(() => {
  mockGenerateTools.mockReset();
  mockSubjectHasContent.mockReset();
  mockAccessedToContext.mockReset().mockReturnValue([]);
  mockGenerateStructured.mockReset();
  mockBacklogCreate.mockReset();
});

describe('runQuery（agentic）', () => {
  it('空 subject → 直接 NO_CONTENT，不调模型', async () => {
    mockSubjectHasContent.mockReturnValue(false);
    const res = await runQuery('问题', SUBJECT);
    expect(res.answer).toBe(NO_QUERY_CONTEXT_ANSWER);
    expect(mockGenerateTools).not.toHaveBeenCalled();
  });

  it('有内容 → 走 generateTextWithTools，返回其 text', async () => {
    mockSubjectHasContent.mockReturnValue(true);
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    const res = await runQuery('问题', SUBJECT);
    expect(mockGenerateTools).toHaveBeenCalledTimes(1);
    expect(res.answer).toBe('答案正文');
  });

  it('模型返回空文本 → 回落 NO_CONTENT', async () => {
    mockSubjectHasContent.mockReturnValue(true);
    mockGenerateTools.mockResolvedValue({ text: '   ' });
    const res = await runQuery('问题', SUBJECT);
    expect(res.answer).toBe(NO_QUERY_CONTEXT_ANSWER);
  });
});

describe('runQuery — coverage gap → research backlog', () => {
  it('coverageSufficient=false → create 恰一次，question 取 suggestedResearchQuestion', async () => {
    mockSubjectHasContent.mockReturnValue(true);
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    mockGenerateStructured.mockResolvedValue({
      citations: [],
      coverageSufficient: false,
      suggestedResearchQuestion: '建议的研究问题',
    });
    await runQuery('原始问题', SUBJECT);
    expect(mockBacklogCreate).toHaveBeenCalledTimes(1);
    expect(mockBacklogCreate).toHaveBeenCalledWith(SUBJECT.id, '建议的研究问题', 'ask-ai');
  });

  it('coverageSufficient=false 且无 suggestedResearchQuestion → 回落用户原问题', async () => {
    mockSubjectHasContent.mockReturnValue(true);
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    mockGenerateStructured.mockResolvedValue({
      citations: [],
      coverageSufficient: false,
    });
    await runQuery('原始问题', SUBJECT);
    expect(mockBacklogCreate).toHaveBeenCalledTimes(1);
    expect(mockBacklogCreate).toHaveBeenCalledWith(SUBJECT.id, '原始问题', 'ask-ai');
  });

  it('空库短路（NO_QUERY_CONTEXT_ANSWER）→ create 一次，question=用户原问题', async () => {
    mockSubjectHasContent.mockReturnValue(false);
    const res = await runQuery('原始问题', SUBJECT);
    expect(res.answer).toBe(NO_QUERY_CONTEXT_ANSWER);
    expect(mockBacklogCreate).toHaveBeenCalledTimes(1);
    expect(mockBacklogCreate).toHaveBeenCalledWith(SUBJECT.id, '原始问题', 'ask-ai');
  });

  it('coverageSufficient=true → 不写 backlog', async () => {
    mockSubjectHasContent.mockReturnValue(true);
    mockGenerateTools.mockResolvedValue({ text: '答案正文' });
    mockGenerateStructured.mockResolvedValue({
      citations: [],
      coverageSufficient: true,
    });
    await runQuery('原始问题', SUBJECT);
    expect(mockBacklogCreate).not.toHaveBeenCalled();
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
