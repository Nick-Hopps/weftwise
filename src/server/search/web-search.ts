import { getWebSearchConfig } from '../db/repos/settings-repo';
import { LLMConfigError } from '../llm/errors';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
const SEARCH_TIMEOUT_MS = 8000;

/** 配置守卫：apiKey trim 后非空才算配置。provider 始终有默认。 */
export function isWebSearchConfigured(): boolean {
  return getWebSearchConfig().apiKey.trim().length > 0;
}

/** Tavily search：返回 LLM-接地用的轻量结果（title/url/snippet）。 */
export async function webSearch(query: string): Promise<WebSearchResult[]> {
  const cfg = getWebSearchConfig();
  if (!cfg.apiKey.trim()) {
    throw new LLMConfigError('Web search is not configured (empty apiKey)');
  }
  const res = (await fetchJson(TAVILY_SEARCH_URL, {
    api_key: cfg.apiKey,
    query,
    max_results: cfg.maxResults,
    search_depth: 'basic',
  })) as { results?: Array<Record<string, unknown>> };

  const rows = Array.isArray(res?.results) ? res.results : [];
  return rows
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.content === 'string' ? r.content : '',
    }))
    .filter((r) => r.url.length > 0);
}

/** Tavily extract：按需抓被引用 URL 的全页正文（raw_content）。 */
export async function extractContent(
  urls: string[],
): Promise<Array<{ url: string; content: string }>> {
  const cfg = getWebSearchConfig();
  if (!cfg.apiKey.trim()) {
    throw new LLMConfigError('Web search is not configured (empty apiKey)');
  }
  if (urls.length === 0) return [];
  const res = (await fetchJson(TAVILY_EXTRACT_URL, {
    api_key: cfg.apiKey,
    urls,
  })) as { results?: Array<Record<string, unknown>> };

  const rows = Array.isArray(res?.results) ? res.results : [];
  return rows
    .map((r) => ({
      url: typeof r.url === 'string' ? r.url : '',
      content: typeof r.raw_content === 'string' ? r.raw_content : '',
    }))
    .filter((r) => r.url.length > 0 && r.content.length > 0);
}

async function fetchJson(url: string, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`Web search HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}
