import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/repos/settings-repo', () => ({
  getWebSearchConfig: vi.fn(),
}));

import { getWebSearchConfig } from '../../db/repos/settings-repo';
import { isWebSearchConfigured, webSearch, extractContent } from '../web-search';

const cfg = getWebSearchConfig as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  cfg.mockReset();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web-search', () => {
  it('isWebSearchConfigured false when apiKey empty/whitespace', () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: '   ', maxResults: 5 });
    expect(isWebSearchConfigured()).toBe(false);
  });

  it('isWebSearchConfigured true when apiKey present', () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 5 });
    expect(isWebSearchConfigured()).toBe(true);
  });

  it('webSearch throws LLMConfigError when not configured', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: '', maxResults: 5 });
    await expect(webSearch('q')).rejects.toThrow(/configured/i);
  });

  it('webSearch maps Tavily results to {title,url,snippet}', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'T1', url: 'https://a.com/x', content: 'snippet-1', raw_content: 'full-1' },
          { title: 'T2', url: 'https://b.com/y', content: 'snippet-2' },
          { title: 'no-url', content: 'drop-me' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await webSearch('hello');
    expect(out).toEqual([
      { title: 'T1', url: 'https://a.com/x', snippet: 'snippet-1' },
      { title: 'T2', url: 'https://b.com/y', snippet: 'snippet-2' },
    ]);
    // 请求体带 api_key/query/max_results
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ api_key: 'tvly-x', query: 'hello', max_results: 3 });
  });

  it('webSearch throws on non-ok HTTP', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    await expect(webSearch('q')).rejects.toThrow(/429/);
  });

  it('webSearch 响应调用方 abort signal', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    let capturedSignal: AbortSignal | undefined;
    let rejectFetch: ((error: Error) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        rejectFetch = reject;
      });
    }));

    const controller = new AbortController();
    const promise = webSearch('q', controller.signal);
    expect(capturedSignal?.aborted).toBe(false);

    controller.abort();
    const signalWasAborted = capturedSignal?.aborted;
    const error = new Error('external abort');
    error.name = 'AbortError';
    rejectFetch?.(error);
    await expect(promise).rejects.toBe(error);
    expect(signalWasAborted).toBe(true);
  });

  it('extractContent maps raw_content and drops empties', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { url: 'https://a.com/x', raw_content: 'FULL TEXT' },
          { url: 'https://b.com/y', raw_content: '' },
        ],
      }),
    }));
    const out = await extractContent(['https://a.com/x', 'https://b.com/y']);
    expect(out).toEqual([{ url: 'https://a.com/x', content: 'FULL TEXT' }]);
  });

  it('extractContent returns [] for empty urls without calling fetch', async () => {
    cfg.mockReturnValue({ provider: 'tavily', apiKey: 'tvly-x', maxResults: 3 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await extractContent([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
