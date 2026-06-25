import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../tool-context';
import { wikiReadTool } from '../wiki-read';
import { wikiSearchTool } from '../wiki-search';
import { wikiListTool } from '../wiki-list';

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    subject: { id: 's1', slug: 'general' } as ToolContext['subject'],
    readPage: vi.fn(async (slug) => (slug === 'a' ? { title: 'A', markdown: 'body-a' } : null)),
    search: vi.fn(async () => [{ slug: 'a', title: 'A', summary: 'sa' }]),
    listPages: vi.fn(async () => [{ slug: 'a', title: 'A', summary: 'sa', tags: ['t'] }]),
    ...over,
  };
}

describe('wiki.read', () => {
  it('命中页返回 markdown 并触发 onAccess', async () => {
    const onAccess = vi.fn();
    const out = await wikiReadTool.handler({ slug: 'a' }, fakeCtx({ onAccess }));
    expect(out).toEqual({ found: true, title: 'A', markdown: 'body-a' });
    expect(onAccess).toHaveBeenCalledWith({ slug: 'a', title: 'A', body: 'body-a' });
  });
  it('未命中返回 found:false 且不触发 onAccess', async () => {
    const onAccess = vi.fn();
    const out = await wikiReadTool.handler({ slug: 'missing' }, fakeCtx({ onAccess }));
    expect(out).toEqual({ found: false, title: null, markdown: null });
    expect(onAccess).not.toHaveBeenCalled();
  });
});

describe('wiki.search', () => {
  it('返回命中并对每条触发 onAccess', async () => {
    const onAccess = vi.fn();
    const out = await wikiSearchTool.handler({ query: 'q' }, fakeCtx({ onAccess }));
    expect(out).toEqual({ hits: [{ slug: 'a', title: 'A', summary: 'sa' }] });
    expect(onAccess).toHaveBeenCalledWith({ slug: 'a', title: 'A' });
  });
});

describe('wiki.list', () => {
  it('返回页清单与 total', async () => {
    const out = await wikiListTool.handler({}, fakeCtx());
    expect(out).toEqual({ pages: [{ slug: 'a', title: 'A', summary: 'sa', tags: ['t'] }], total: 1 });
  });
});
