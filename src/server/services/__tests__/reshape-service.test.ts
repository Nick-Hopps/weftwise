import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamMock = vi.fn();
vi.mock('@/server/llm/provider-registry', () => ({
  streamTextResponse: (...args: unknown[]) => streamMock(...args),
}));
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

beforeEach(() => streamMock.mockReset());

describe('reshapePageBody', () => {
  it('保真通过 → 返回重塑正文，fallback=false', async () => {
    streamMock.mockReturnValueOnce(fakeStream('重塑：见 [[Alpha]]'));
    const { reshapePageBody } = await import('../reshape-service');
    const r = await reshapePageBody({ subject, body: '原文 [[Alpha]]', profile });
    expect(r.fallback).toBe(false);
    expect(r.body).toContain('重塑');
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it('首次臆造链接 → 重写一次；第二次干净 → 通过', async () => {
    streamMock
      .mockReturnValueOnce(fakeStream('[[Alpha]] 还有臆造 [[Ghost]]'))
      .mockReturnValueOnce(fakeStream('干净 [[Alpha]]'));
    const { reshapePageBody } = await import('../reshape-service');
    const r = await reshapePageBody({ subject, body: '原文 [[Alpha]]', profile });
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(r.fallback).toBe(false);
    expect(r.body).toContain('干净');
  });

  it('两次都臆造 → 回落 canonical，fallback=true', async () => {
    streamMock
      .mockReturnValueOnce(fakeStream('[[Ghost1]]'))
      .mockReturnValueOnce(fakeStream('[[Ghost2]]'));
    const { reshapePageBody } = await import('../reshape-service');
    const r = await reshapePageBody({ subject, body: '原文 [[Alpha]]', profile });
    expect(r.fallback).toBe(true);
    expect(r.body).toBe('原文 [[Alpha]]');
  });
});
