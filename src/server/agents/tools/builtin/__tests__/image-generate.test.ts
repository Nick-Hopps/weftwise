import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  resolveTask: vi.fn(() => ({
    task: 'ingest:image', profileName: 'google', provider: { provider: 'google' }, model: 'gemini-3.1-flash-image-preview',
    maxTokens: 4096, temperature: 0.2,
    providerOptions: { google: { imageConfig: { imageSize: '1K' } } } as { google: { imageConfig: { imageSize: string } } } | undefined,
  })),
  getLanguageModel: vi.fn(() => ({ modelId: 'gemini-3.1-flash-image-preview' })),
  recordUsage: vi.fn(),
}));
vi.mock('ai', () => ({ generateText: mocks.generateText }));
vi.mock('@/server/llm/task-router', () => ({ resolveTask: mocks.resolveTask }));
vi.mock('@/server/llm/provider-factory', () => ({ getLanguageModel: mocks.getLanguageModel }));
vi.mock('@/server/db/repos/usage-repo', () => ({ recordUsage: mocks.recordUsage }));

import type { ToolContext } from '../../tool-context';
import { generateImageAsset, imageGenerateTool } from '../image-generate';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    subject: { id: 's1', slug: 'general' },
    readPage: vi.fn(async () => null),
    search: vi.fn(async () => []),
    listPages: vi.fn(async () => ({ pages: [], nextCursor: null })),
    ...overrides,
  } as ToolContext;
}

describe('image.generate', () => {
  beforeEach(() => {
    mocks.generateText.mockReset();
    mocks.recordUsage.mockReset();
  });

  it('接受图片生成输入，不再把 Mermaid 当作唯一输出类型', () => {
    expect(imageGenerateTool.inputSchema.safeParse({
      prompt: 'show the geometric intuition', alt: 'Geometric intuition',
    }).success).toBe(true);
    expect(imageGenerateTool.inputSchema.safeParse({
      pageSlug: 'linear-algebra', prompt: 'show the geometric intuition', alt: 'Geometric intuition',
    }).success).toBe(false);
  });

  it('调用 image response 并返回可嵌入页面的 asset URL', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.generateText.mockResolvedValue({
      files: [{ mediaType: 'image/png', base64: Buffer.from(bytes).toString('base64'), uint8Array: bytes }],
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const usage = vi.fn();
    const result = await generateImageAsset({
      prompt: 'show the geometric intuition', alt: 'Geometric intuition',
    }, 'general', usage);
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: { google: { imageConfig: { imageSize: '1K' }, responseModalities: ['IMAGE'] } },
    }));
    expect(result.output).toMatchObject({ type: 'image', url: expect.stringMatching(/^\/api\/assets\/general\/[a-f0-9-]+\.png$/), alt: 'Geometric intuition' });
    expect(result.asset.path).toMatch(/^assets\/general\/[a-f0-9-]+\.png$/);
    expect(result.asset.content).toBe(Buffer.from(bytes).toString('base64'));
    expect(result.asset.mediaType).toBe('image/png');
    expect(usage).toHaveBeenCalledWith({ inputTokens: 12, outputTokens: 3 });
  });

  it('把调用方 abort signal 传给图片模型', async () => {
    const controller = new AbortController();
    const bytes = new Uint8Array([1]);
    mocks.generateText.mockResolvedValue({
      files: [{ mediaType: 'image/png', base64: 'AQ==', uint8Array: bytes }],
      usage: {},
    });

    await generateImageAsset({ prompt: 'x', alt: 'x' }, 'general', undefined, controller.signal);

    const signal = mocks.generateText.mock.calls[0][0].abortSignal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('未注入 enrich 能力时明确拒绝', async () => {
    await expect(imageGenerateTool.handler({ prompt: 'x', alt: 'x' }, ctx())).rejects.toThrow(/only available/i);
  });

  it('拒绝把图片任务回退到文本模型', async () => {
    mocks.resolveTask.mockReturnValueOnce({
      task: 'ingest:image', profileName: 'deepseek', provider: { provider: 'deepseek' }, model: 'deepseek-v4-pro',
      maxTokens: 4096, temperature: 0.2, providerOptions: undefined,
    });

    await expect(generateImageAsset({ prompt: 'x', alt: 'x' }, 'general'))
      .rejects.toThrow(/ingest:image.*Google image model/i);
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
