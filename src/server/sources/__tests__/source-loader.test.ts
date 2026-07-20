import { describe, expect, it, vi } from 'vitest';
import type { Source } from '@/lib/contracts';

const rawSource: Source = {
  id: 'raw-1',
  subjectId: 'sub-1',
  filename: 'note.md',
  contentHash: 'hash',
  parsedAt: null,
  metadataJson: '{}',
};

const urlSource: Source = {
  ...rawSource,
  id: 'url-1',
  filename: 'web-example.html',
  metadataJson: JSON.stringify({ kind: 'url', originUrl: 'https://example.com/a' }),
};

describe('loadSourceForIngest', () => {
  it('URL Source 在 worker 边界抓取远程正文并按响应格式解析', async () => {
    const { loadSourceForIngest } = await import('../source-loader');
    const fetchUrlSource = vi.fn(async () => ({
      filename: 'remote.html',
      content: '<title>Remote title</title><meta name="description" content="Remote summary"><p>正文</p>',
    }));

    const result = await loadSourceForIngest(urlSource, 'general', { fetchUrlSource });

    expect(fetchUrlSource).toHaveBeenCalledWith('https://example.com/a');
    expect(result.kind).toBe('url');
    expect(result.title).toBe('Remote title');
    expect(result.description).toBe('Remote summary');
    expect(result.cleanText).toContain('正文');
  });

  it('URL Source 将短期授权交给抓取器，普通 Source 不接触授权', async () => {
    const { loadSourceForIngest } = await import('../source-loader');
    const fetchUrlSource = vi.fn(async () => ({
      filename: 'remote.html',
      content: '<p>Private</p>',
    }));
    const credentials = {
      origin: 'https://example.com',
      cookie: 'session=secret',
      authorization: 'Bearer secret',
    };

    await loadSourceForIngest(urlSource, 'general', { fetchUrlSource, credentials });

    expect(fetchUrlSource).toHaveBeenCalledWith('https://example.com/a', { credentials });
  });

  it('普通文本 Source 继续读取 raw 文件且不访问网络', async () => {
    const { loadSourceForIngest } = await import('../source-loader');
    const fetchUrlSource = vi.fn();
    const getRawSourceContent = vi.fn(() => '# Local');

    const result = await loadSourceForIngest(rawSource, 'general', {
      fetchUrlSource,
      getRawSourceContent,
      getRawSourceBuffer: vi.fn(() => null),
    });

    expect(fetchUrlSource).not.toHaveBeenCalled();
    expect(getRawSourceContent).toHaveBeenCalledWith('general', 'note.md');
    expect(result).toMatchObject({ kind: 'raw', cleanText: '# Local' });
  });
});
