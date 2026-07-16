import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ stream: vi.fn(), generateImage: vi.fn() }));
vi.mock('@/server/llm/provider-registry', () => ({
  streamTextWithTools: (...args: unknown[]) => mocks.stream(...args),
  streamTextResponse: (...args: unknown[]) => mocks.stream(...args),
}));
vi.mock('@/server/agents/tools/builtin/image-generate', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('@/server/agents/tools/builtin/image-generate')>();
  return { ...original, generateImageAsset: (...args: unknown[]) => mocks.generateImage(...args) };
});
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: () => 'Chinese' }));

// streamTextResponse 返回一个带 textStream 的对象
function fakeStream(text: string) {
  return {
    textStream: (async function* () {
      yield text;
    })(),
  };
}

const subject = {
  id: 's1',
  slug: 'general',
  name: 'G',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '',
  updatedAt: '',
} as never;
const profile = {
  backgroundSummary: '',
  stylePrefs: { readingLevel: 'intermediate', verbosity: 'balanced', exampleDensity: 'some', formality: 'neutral' },
} as never;

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.generateImage.mockReset();
});

describe('reshapePageBody', () => {
  it('直接返回模型自由重塑的正文', async () => {
    mocks.stream.mockReturnValueOnce(fakeStream('重塑：见 [[Alpha]]'));
    const { reshapePageBody } = await import('../reshape-service');
    const r = await reshapePageBody({ subject, body: '原文 [[Alpha]]', profile });
    expect(r.body).toContain('重塑');
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it('接受大幅缩写与新链接，不再触发保真重试或回落', async () => {
    mocks.stream.mockReturnValueOnce(fakeStream('短版 [[NewConcept]]'));
    const { reshapePageBody } = await import('../reshape-service');
    const r = await reshapePageBody({ subject, body: '很长的原文内容'.repeat(100), profile });
    expect(r.body).toBe('短版 [[NewConcept]]');
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it('图片工具返回 rendition URL，并把二进制暂存到结果', async () => {
    const signal = new AbortController().signal;
    mocks.generateImage.mockResolvedValue({
      output: { type: 'image', path: 'assets/general/image-1.png', url: '/api/assets/general/image-1.png', alt: '图解' },
      asset: { path: 'assets/general/image-1.png', content: 'AQID', mediaType: 'image/png' },
    });
    mocks.stream.mockImplementationOnce((_task, options) => {
      const imageTool = options.tools.image_generate;
      return {
        textStream: (async function* () {
          const image = await imageTool.execute({ prompt: '画图', alt: '图解' });
          yield `![图解](${image.url})`;
        })(),
      };
    });

    const { reshapePageBody } = await import('../reshape-service');
    const result = await reshapePageBody({ subject, body: '原文', profile, abortSignal: signal });

    expect(result.body).toBe('![图解](/api/rendition-assets/image-1)');
    expect(result.assets).toEqual([{ id: 'image-1', mediaType: 'image/png', dataBase64: 'AQID' }]);
    expect(mocks.generateImage).toHaveBeenCalledWith(expect.anything(), 'general', undefined, signal);
  });
});
