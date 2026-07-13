import { describe, it, expect, vi } from 'vitest';
import {
  extensionForContentType,
  deriveUrlFilename,
  fetchUrlSource,
  MAX_URL_BYTES,
  type UrlRequestTransport,
} from '../url-fetcher';

async function* chunks(...values: Array<string | Uint8Array>) {
  for (const value of values) {
    yield typeof value === 'string' ? Buffer.from(value) : value;
  }
}

function fakeTransport(opts: {
  status?: number;
  contentType?: string;
  body?: string;
  bytes?: number;
  location?: string;
}): UrlRequestTransport {
  const body = opts.body ?? '<html><body>hi</body></html>';
  const buf = opts.bytes ? Buffer.alloc(opts.bytes, 'a') : Buffer.from(body, 'utf-8');
  return vi.fn(async () => ({
    status: opts.status ?? 200,
    headers: {
      'content-type': opts.contentType ?? 'text/html; charset=utf-8',
      ...(opts.location ? { location: opts.location } : {}),
    },
    body: chunks(buf),
    close: vi.fn(),
  }));
}

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

describe('extensionForContentType', () => {
  it('按 content-type 分派扩展名', () => {
    expect(extensionForContentType('text/html; charset=utf-8')).toBe('.html');
    expect(extensionForContentType('application/xhtml+xml')).toBe('.html');
    expect(extensionForContentType('text/markdown')).toBe('.md');
    expect(extensionForContentType('text/plain')).toBe('.txt');
    expect(extensionForContentType('')).toBe('.html'); // 未声明按 html 处理
    expect(extensionForContentType('image/png')).toBeNull();
    expect(extensionForContentType('application/pdf')).toBeNull();
  });
});

describe('deriveUrlFilename', () => {
  it('派生 web-<host>-<末段>-<hash><ext>，同 URL 稳定', () => {
    const a = deriveUrlFilename('https://www.example.com/docs/Intro?x=1', '.html');
    expect(a).toMatch(/^web-example\.com-intro-[0-9a-f]{8}\.html$/);
    expect(deriveUrlFilename('https://www.example.com/docs/Intro?x=1', '.html')).toBe(a);
  });
  it('无路径/非法输入回落 page 兜底', () => {
    expect(deriveUrlFilename('::::', '.txt')).toMatch(/^web-page-[0-9a-f]{8}\.txt$/);
  });
});

describe('fetchUrlSource', () => {
  it('HTML 页面存为 .html，正文原样返回', async () => {
    const transport = fakeTransport({ body: '<h1>Doc</h1>' });
    const out = await fetchUrlSource('https://example.com/doc', { transport, resolver: publicResolver });
    expect(out.filename).toMatch(/\.html$/);
    expect(out.content).toBe('<h1>Doc</h1>');
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      address: '93.184.216.34',
      family: 4,
      hostname: 'example.com',
    }));
  });
  it('markdown content-type 存为 .md', async () => {
    const transport = fakeTransport({ contentType: 'text/markdown', body: '# hi' });
    const out = await fetchUrlSource('https://example.com/readme', { transport, resolver: publicResolver });
    expect(out.filename).toMatch(/\.md$/);
  });
  it('非 2xx 报错', async () => {
    const transport = fakeTransport({ status: 404 });
    await expect(fetchUrlSource('https://example.com/x', { transport, resolver: publicResolver })).rejects.toThrow(/404/);
  });
  it('非文本 content-type 拒绝', async () => {
    const transport = fakeTransport({ contentType: 'image/png' });
    await expect(fetchUrlSource('https://example.com/x', { transport, resolver: publicResolver })).rejects.toThrow(/content-type/i);
  });
  it('响应体超 5MB 拒绝', async () => {
    const transport = fakeTransport({ bytes: MAX_URL_BYTES + 1 });
    await expect(fetchUrlSource('https://example.com/x', { transport, resolver: publicResolver })).rejects.toThrow(/too large/i);
  });

  it('流式读取一旦超过 5MB 立即关闭响应', async () => {
    const close = vi.fn();
    const transport: UrlRequestTransport = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: chunks(Buffer.alloc(MAX_URL_BYTES), Buffer.from('x')),
      close,
    }));

    await expect(fetchUrlSource('https://example.com/large', { transport, resolver: publicResolver }))
      .rejects.toThrow(/too large/i);
    expect(close).toHaveBeenCalledOnce();
  });

  it('手动跟随相对重定向，并为每一跳重新解析和固定地址', async () => {
    const resolver = vi.fn(async (hostname: string) => [{
      address: hostname === 'example.com' ? '93.184.216.34' : '1.1.1.1',
      family: 4 as const,
    }]);
    const transport: UrlRequestTransport = vi.fn(async ({ url }) => url.pathname === '/start'
      ? {
          status: 302,
          headers: { location: '/final' },
          body: chunks(),
          close: vi.fn(),
        }
      : {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: chunks('<p>ok</p>'),
          close: vi.fn(),
        });

    await expect(fetchUrlSource('https://example.com/start', { transport, resolver }))
      .resolves.toMatchObject({ content: '<p>ok</p>' });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('拒绝 public 页面重定向到 private 地址', async () => {
    const transport = fakeTransport({ status: 302, location: 'http://127.0.0.1/secret' });

    await expect(fetchUrlSource('https://example.com/start', { transport, resolver: publicResolver }))
      .rejects.toThrow(/public/i);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('拒绝超过 5 跳重定向', async () => {
    const transport: UrlRequestTransport = vi.fn(async ({ url }) => ({
      status: 302,
      headers: { location: `/hop-${Number(url.pathname.split('-')[1] ?? 0) + 1}` },
      body: chunks(),
      close: vi.fn(),
    }));

    await expect(fetchUrlSource('https://example.com/hop-0', { transport, resolver: publicResolver }))
      .rejects.toThrow(/redirect/i);
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it('超时会中止 transport 并返回稳定错误', async () => {
    const transport: UrlRequestTransport = vi.fn(({ signal }) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));

    await expect(fetchUrlSource('https://example.com/slow', {
      transport,
      resolver: publicResolver,
      timeoutMs: 5,
    })).rejects.toThrow(/timed out/i);
  });

  it('DNS resolver 卡住时也受总超时约束', async () => {
    const resolver = vi.fn(() => new Promise<never>(() => undefined));
    const transport = fakeTransport({});

    await expect(fetchUrlSource('https://example.com/slow-dns', {
      transport,
      resolver,
      timeoutMs: 5,
    })).rejects.toThrow(/timed out/i);
    expect(transport).not.toHaveBeenCalled();
  });
});
