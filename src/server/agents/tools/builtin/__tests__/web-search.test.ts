import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../tool-context';
import { webSearchTool } from '../web-search';

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    subject: { id: 's1', slug: 'general' } as ToolContext['subject'],
    readPage: vi.fn(async () => null),
    search: vi.fn(async () => []),
    listPages: vi.fn(async () => ({ pages: [], nextCursor: null })),
    ...over,
  };
}

describe('web.search', () => {
  it('delegates to ctx.webSearch and caps results to 5', async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `T${i}`,
      url: `https://example.com/${i}`,
      snippet: `S${i}`,
    }));
    const webSearch = vi.fn(async () => results);
    const out = await webSearchTool.handler({ query: 'foo' }, fakeCtx({ webSearch }));
    expect(webSearch).toHaveBeenCalledWith('foo');
    expect(out.results).toHaveLength(5);
    expect(out.results[0]).toEqual(results[0]);
  });

  it('throws a clear error when ctx.webSearch is not provided', async () => {
    await expect(webSearchTool.handler({ query: 'foo' }, fakeCtx())).rejects.toThrow(
      /not available/i,
    );
  });
});
