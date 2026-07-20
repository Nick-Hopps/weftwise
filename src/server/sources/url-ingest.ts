import { validateHttpUrl } from './url-fetcher';

/** 单次请求 URL 条数上限。 */
export const MAX_URLS_PER_REQUEST = 20;

export interface UrlIngestResult {
  url: string;
  jobId?: string;
  sourceId?: string;
  error?: string;
}

export interface UrlIngestDeps {
  persist: (url: string) => { sourceId: string; jobId: string };
}

/** 校验 urls 请求体：trim / 去空 / 去重 / 协议校验 / 上限。 */
export function validateUrlList(input: unknown): { urls: string[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: '"urls" must be a non-empty array of strings' };
  }
  const urls: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') return { error: '"urls" must be a non-empty array of strings' };
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      validateHttpUrl(trimmed);
    } catch (err) {
      return { error: `Invalid URL "${trimmed}": ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!urls.includes(trimmed)) urls.push(trimmed);
  }
  if (urls.length === 0) return { error: '"urls" contains no usable URLs' };
  if (urls.length > MAX_URLS_PER_REQUEST) {
    return { error: `Too many URLs (${urls.length}); maximum is ${MAX_URLS_PER_REQUEST}` };
  }
  return { urls };
}

/** 逐 URL 创建链接型 Source→入队；单条失败不阻断其余（allSettled 语义）。 */
export async function ingestUrlBatch(urls: string[], deps: UrlIngestDeps): Promise<UrlIngestResult[]> {
  const settled = await Promise.allSettled(
    urls.map(async (url) => {
      const { sourceId, jobId } = deps.persist(url);
      return { url, sourceId, jobId } satisfies UrlIngestResult;
    }),
  );
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { url: urls[i], error: s.reason instanceof Error ? s.reason.message : String(s.reason) },
  );
}
