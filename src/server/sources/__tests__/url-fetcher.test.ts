import { describe, it, expect, vi } from 'vitest';
import {
  validateHttpUrl,
  extensionForContentType,
  deriveUrlFilename,
  fetchUrlSource,
  MAX_URL_BYTES,
} from '../url-fetcher';

function fakeFetch(opts: { status?: number; contentType?: string; body?: string; bytes?: number }) {
  const body = opts.body ?? '<html><body>hi</body></html>';
  const buf = opts.bytes ? Buffer.alloc(opts.bytes, 'a') : Buffer.from(body, 'utf-8');
  return vi.fn(async () =>
    new Response(new Uint8Array(buf), {
      status: opts.status ?? 200,
      headers: { 'content-type': opts.contentType ?? 'text/html; charset=utf-8' },
    }),
  ) as unknown as typeof fetch;
}

describe('validateHttpUrl', () => {
  it('接受 http/https', () => {
    expect(validateHttpUrl('https://example.com/a').hostname).toBe('example.com');
  });
  it('拒绝非 http(s) 协议与非法 URL', () => {
    expect(() => validateHttpUrl('ftp://example.com')).toThrow();
    expect(() => validateHttpUrl('not-a-url')).toThrow();
  });
});

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
    const f = fakeFetch({ body: '<h1>Doc</h1>' });
    const out = await fetchUrlSource('https://example.com/doc', f);
    expect(out.filename).toMatch(/\.html$/);
    expect(out.content).toBe('<h1>Doc</h1>');
  });
  it('markdown content-type 存为 .md', async () => {
    const f = fakeFetch({ contentType: 'text/markdown', body: '# hi' });
    const out = await fetchUrlSource('https://example.com/readme', f);
    expect(out.filename).toMatch(/\.md$/);
  });
  it('非 2xx 报错', async () => {
    const f = fakeFetch({ status: 404 });
    await expect(fetchUrlSource('https://example.com/x', f)).rejects.toThrow(/404/);
  });
  it('非文本 content-type 拒绝', async () => {
    const f = fakeFetch({ contentType: 'image/png' });
    await expect(fetchUrlSource('https://example.com/x', f)).rejects.toThrow(/content-type/i);
  });
  it('响应体超 5MB 拒绝', async () => {
    const f = fakeFetch({ bytes: MAX_URL_BYTES + 1 });
    await expect(fetchUrlSource('https://example.com/x', f)).rejects.toThrow(/too large/i);
  });
});
