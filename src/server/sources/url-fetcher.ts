import { createHash } from 'crypto';

/** URL 抓取守卫常量：超时 10s、响应体上限 5MB。 */
export const URL_FETCH_TIMEOUT_MS = 10_000;
export const MAX_URL_BYTES = 5 * 1024 * 1024;

/** 校验并解析 http(s) URL；非法或非 http(s) 协议抛错。 */
export function validateHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${u.protocol}`);
  }
  return u;
}

/**
 * content-type → 保存扩展名分派。存 .html 让现有 turndown html-parser 接管；
 * null 表示非文本类型，调用方应拒绝。未声明 content-type 的按 html 处理（多数网页）。
 */
export function extensionForContentType(contentType: string): '.html' | '.md' | '.txt' | null {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === '' || ct === 'text/html' || ct === 'application/xhtml+xml') return '.html';
  if (ct === 'text/markdown' || ct === 'text/x-markdown') return '.md';
  if (ct.startsWith('text/')) return '.txt';
  return null;
}

/** 从 URL 派生安全文件名（host + 末段 + 短 hash + 指定扩展名）。 */
export function deriveUrlFilename(url: string, ext: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 8);
  let base = 'page';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    base = `${host}-${last}`
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    base = base.slice(0, 80) || 'page';
  } catch {
    base = 'page';
  }
  return `web-${base}-${hash}${ext}`;
}

/**
 * 抓取网页并按 content-type 决定保存格式。
 * 守卫：http(s) 协议、超时、content-length/实际体积 ≤ 5MB、仅文本类型。
 */
export async function fetchUrlSource(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ filename: string; content: string }> {
  validateHttpUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}`);

    const contentType = resp.headers.get('content-type') ?? '';
    const ext = extensionForContentType(contentType);
    if (!ext) throw new Error(`Unsupported content-type: ${contentType || 'unknown'}`);

    const declared = Number(resp.headers.get('content-length') ?? 0);
    if (declared > MAX_URL_BYTES) throw new Error('Response too large (max 5MB)');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_URL_BYTES) throw new Error('Response too large (max 5MB)');

    return { filename: deriveUrlFilename(url, ext), content: buf.toString('utf-8') };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Fetch timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
