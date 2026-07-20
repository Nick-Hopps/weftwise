import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSourcesForPage: vi.fn(),
  getSourceMetadata: vi.fn(),
  getRawSourceContent: vi.fn(),
}));

vi.mock('../../db/repos/sources-repo', () => ({
  getSourcesForPage: (...args: unknown[]) => mocks.getSourcesForPage(...args),
}));

vi.mock('../source-store', () => ({
  getSourceMetadata: (...args: unknown[]) => mocks.getSourceMetadata(...args),
  getRawSourceContent: (...args: unknown[]) => mocks.getRawSourceContent(...args),
}));

describe('readPageSources URL Source', () => {
  beforeEach(() => {
    mocks.getRawSourceContent.mockReset();
    mocks.getSourceMetadata.mockReset().mockReturnValue({ savedAt: '2026-07-20T00:00:00Z' });
    mocks.getSourcesForPage.mockReset().mockReturnValue([{
      id: 'src-url',
      subjectId: 'sub-1',
      filename: 'web-example.html',
      contentHash: 'hash',
      parsedAt: null,
      metadataJson: JSON.stringify({ kind: 'url', originUrl: 'https://example.com/a' }),
    }]);
  });

  it('下发远程 sourceUrl，不读取或扫描本地 HTML', async () => {
    const { readPageSources } = await import('../source-reader');

    const docs = readPageSources({ id: 'sub-1', slug: 'general' }, 'page-a');

    expect(docs).toEqual([expect.objectContaining({
      id: 'src-url',
      format: 'html',
      meta: 'Web',
      sourceUrl: 'https://example.com/a',
    })]);
    expect(docs[0]).not.toHaveProperty('htmlSafety');
    expect(mocks.getRawSourceContent).not.toHaveBeenCalled();
  });
});
