import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveSubject: vi.fn(),
  listSources: vi.fn(),
  readPageSources: vi.fn(),
}));

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mocks.resolveSubject(...args),
}));
vi.mock('@/server/db/repos/sources-repo', () => ({
  listSourcesForSubject: (...args: unknown[]) => mocks.listSources(...args),
}));
vi.mock('@/server/sources/source-reader', () => ({
  readPageSources: (...args: unknown[]) => mocks.readPageSources(...args),
}));

import { GET } from '../route';

describe('GET /api/sources 侧栏列表', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSubject.mockReturnValue({
      subject: { id: 'sub-1', slug: 'general' },
      error: null,
    });
  });

  it('URL Source 返回持久化网页标题与描述，不再用链接作为标签', async () => {
    mocks.listSources.mockReturnValue([{
      id: 'url-1',
      subjectId: 'sub-1',
      filename: 'web-example-com-article.html',
      contentHash: 'hash',
      parsedAt: null,
      metadataJson: JSON.stringify({
        kind: 'url',
        originUrl: 'https://www.example.com/article',
        title: 'Example article',
        description: 'An explanatory summary.',
      }),
    }]);

    const response = await GET(new NextRequest('http://localhost/api/sources'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sources: [{
        id: 'url-1',
        filename: 'web-example-com-article.html',
        format: 'Web',
        title: 'Example article',
        description: 'An explanatory summary.',
      }],
    });
  });

  it('采集自主检索导入的网页源展示已持久化标题与描述', async () => {
    mocks.listSources.mockReturnValue([{
      id: 'web-1',
      subjectId: 'sub-1',
      filename: 'web-news.gmw.cn-content_36241753-9fe1f0aa.md',
      contentHash: 'hash',
      parsedAt: null,
      metadataJson: JSON.stringify({
        filename: 'web-news.gmw.cn-content_36241753-9fe1f0aa.md',
        title: '从"国家"概念的出现到近代的全球史',
        description: '这篇文章讨论了国家概念的起源。',
      }),
    }]);

    const response = await GET(new NextRequest('http://localhost/api/sources'));

    expect(await response.json()).toEqual({
      sources: [{
        id: 'web-1',
        filename: 'web-news.gmw.cn-content_36241753-9fe1f0aa.md',
        format: 'Markdown',
        title: '从"国家"概念的出现到近代的全球史',
        description: '这篇文章讨论了国家概念的起源。',
      }],
    });
  });

  it('待抓取 URL 回退 hostname，普通文件继续回退 filename', async () => {
    mocks.listSources.mockReturnValue([
      {
        id: 'url-1', subjectId: 'sub-1', filename: 'web-example.html', contentHash: 'h1', parsedAt: null,
        metadataJson: JSON.stringify({ kind: 'url', originUrl: 'https://www.example.com/article' }),
      },
      {
        id: 'raw-1', subjectId: 'sub-1', filename: 'notes.pdf', contentHash: 'h2', parsedAt: null,
        metadataJson: '{}',
      },
    ]);

    const response = await GET(new NextRequest('http://localhost/api/sources'));
    const body = await response.json();

    expect(body.sources).toEqual([
      expect.objectContaining({ id: 'url-1', title: 'example.com', format: 'Web' }),
      expect.objectContaining({ id: 'raw-1', title: 'notes.pdf', format: 'PDF' }),
    ]);
  });
});
