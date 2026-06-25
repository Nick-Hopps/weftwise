import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted 确保变量在 vi.mock 工厂函数提升前已初始化
const {
  mockGenerateTools,
  mockSubjectHasContent,
  mockBuildToolContext,
  mockAccessedToContext,
  mockCompileToolSet,
} = vi.hoisted(() => ({
  mockGenerateTools: vi.fn(),
  mockSubjectHasContent: vi.fn(),
  mockBuildToolContext: vi.fn(() => ({})),
  mockAccessedToContext: vi.fn(() => [] as unknown[]),
  mockCompileToolSet: vi.fn(() => ({})),
}));

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: () => 'English' }));
vi.mock('@/server/llm/provider-registry', () => ({
  generateStructuredOutput: vi.fn(),
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

import { runQuery, NO_QUERY_CONTEXT_ANSWER } from '../query-service';

const SUBJECT = {
  id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard' as const, createdAt: 't', updatedAt: 't',
};

beforeEach(() => {
  mockGenerateTools.mockReset();
  mockSubjectHasContent.mockReset();
  mockAccessedToContext.mockReset().mockReturnValue([]);
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
