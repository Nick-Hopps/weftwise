import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import {
  resolvePublicHttpTarget,
  validateHttpUrl,
  type HostResolver,
  type PublicHttpTarget,
} from './url-safety';

export { validateHttpUrl } from './url-safety';

/** URL 抓取守卫常量：总超时 10s、响应体上限 5MB、重定向最多 5 跳。 */
export const URL_FETCH_TIMEOUT_MS = 10_000;
export const MAX_URL_BYTES = 5 * 1024 * 1024;
export const MAX_URL_REDIRECTS = 5;

export interface UrlTransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
}

export interface UrlTransportRequest extends PublicHttpTarget {
  signal: AbortSignal;
}

export type UrlRequestTransport = (
  request: UrlTransportRequest,
) => Promise<UrlTransportResponse>;

export interface FetchUrlSourceOptions {
  resolver?: HostResolver;
  transport?: UrlRequestTransport;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * content-type → 保存扩展名分派。存 .html 让现有 turndown html-parser 接管；
 * null 表示非文本类型，调用方应拒绝。未声明 content-type 的按 html 处理（多数网页）。
 */
export function extensionForContentType(contentType: string): '.html' | '.md' | '.txt' | null {
  const ct = contentType.split(';')[0]!.trim().toLowerCase();
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
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
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
 * SSRF-safe URL 抓取：每跳解析全部 DNS、固定已验证 IP、手动校验重定向，
 * 同时保留总超时、文本 content-type 与 5MB 流式上限。
 */
export async function fetchUrlSource(
  rawUrl: string,
  options: FetchUrlSourceOptions = {},
): Promise<{ filename: string; content: string }> {
  const timeoutMs = options.timeoutMs ?? URL_FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_URL_REDIRECTS;
  const transport = options.transport ?? nodeRequestTransport;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Fetch timeout must be positive');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error('Maximum redirects must be a non-negative integer');
  }

  const originalUrl = validateHttpUrl(rawUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current = originalUrl;

  try {
    for (let redirects = 0; ; redirects += 1) {
      const target = await raceWithAbort(
        resolvePublicHttpTarget(current, options.resolver),
        controller.signal,
      );
      const response = await raceWithAbort(
        transport({ ...target, signal: controller.signal }),
        controller.signal,
      );
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        response.close();
      };

      if (isRedirect(response.status)) {
        const location = response.headers.location;
        close();
        if (!location) throw new Error(`Redirect response missing Location header: HTTP ${response.status}`);
        if (redirects >= maxRedirects) throw new Error(`Too many redirects (maximum ${maxRedirects})`);
        current = new URL(location, target.url).toString();
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        close();
        throw new Error(`Fetch failed: HTTP ${response.status}`);
      }

      const contentType = response.headers['content-type'] ?? '';
      const contentEncoding = response.headers['content-encoding']?.trim().toLowerCase();
      if (contentEncoding && contentEncoding !== 'identity') {
        close();
        throw new Error(`Unsupported content-encoding: ${contentEncoding}`);
      }
      const ext = extensionForContentType(contentType);
      if (!ext) {
        close();
        throw new Error(`Unsupported content-type: ${contentType || 'unknown'}`);
      }

      const declared = parseContentLength(response.headers['content-length']);
      if (declared !== null && declared > MAX_URL_BYTES) {
        close();
        throw new Error('Response too large (max 5MB)');
      }

      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          total += buffer.byteLength;
          if (total > MAX_URL_BYTES) {
            close();
            throw new Error('Response too large (max 5MB)');
          }
          chunks.push(buffer);
        }
      } catch (error) {
        close();
        throw error;
      }

      return {
        filename: deriveUrlFilename(originalUrl, ext),
        content: Buffer.concat(chunks, total).toString('utf-8'),
      };
    }
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error(`Fetch timed out after ${timeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

/** 使用已验证 IP 作为 socket hostname；HTTPS 仍以原 hostname 做 SNI/证书校验。 */
const nodeRequestTransport: UrlRequestTransport = async (target) =>
  new Promise((resolve, reject) => {
    const client = target.url.protocol === 'https:' ? https : http;
    const request = client.request(
      {
        protocol: target.url.protocol,
        hostname: target.address,
        port: target.url.port || undefined,
        method: 'GET',
        path: `${target.url.pathname}${target.url.search}`,
        headers: {
          Host: target.url.host,
          Accept: 'text/html,text/markdown,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Agentic-Wiki/1.0',
        },
        ...(target.url.protocol === 'https:' ? { servername: target.hostname } : {}),
        signal: target.signal,
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          body: response,
          close: () => response.destroy(),
        });
      },
    );
    request.once('error', reject);
    request.end();
  });

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return normalized;
}
