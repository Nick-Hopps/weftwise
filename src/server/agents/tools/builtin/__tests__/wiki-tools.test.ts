import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../tool-context';
import { wikiReadTool } from '../wiki-read';
import { wikiSearchTool } from '../wiki-search';
import { wikiListTool } from '../wiki-list';
import { wikiInspectTool } from '../wiki-inspect';
import { sourceSearchTool } from '../source-search';
import { sourceReadTool } from '../source-read';

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    subject: { id: 's1', slug: 'general' } as ToolContext['subject'],
    readPage: vi.fn(async (slug) => (slug === 'a' ? { title: 'A', markdown: 'body-a' } : null)),
    search: vi.fn(async () => [{ slug: 'a', title: 'A', summary: 'sa' }]),
    listPages: vi.fn(async () => ({
      pages: [{
        slug: 'a', title: 'A', summary: 'sa', tags: ['t'], updatedAt: '2026-01-01',
      }],
      nextCursor: null,
    })),
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
  it('返回可继续页清单并透传输入', async () => {
    const listPages = vi.fn(async () => ({ pages: [], nextCursor: 'next' }));
    const ctx = fakeCtx({ listPages });
    const input = { limit: 10, sort: 'updated' as const, tag: 'topic' };
    const out = await wikiListTool.handler(input, ctx);
    expect(listPages).toHaveBeenCalledWith(input);
    expect(out).toEqual({ pages: [], nextCursor: 'next' });
  });
  it('默认返回页清单与 nextCursor', async () => {
    const out = await wikiListTool.handler({}, fakeCtx());
    expect(out).toEqual({
      pages: [{
        slug: 'a', title: 'A', summary: 'sa', tags: ['t'], updatedAt: '2026-01-01',
      }],
      nextCursor: null,
    });
  });
  it('对每页触发 onAccess', async () => {
    const onAccess = vi.fn();
    await wikiListTool.handler({}, fakeCtx({ onAccess }));
    expect(onAccess).toHaveBeenCalledWith({ slug: 'a', title: 'A' });
  });
});

describe('wiki.inspect', () => {
  it('委托 ctx.inspectPage 且不返回正文', async () => {
    const inspectPage = vi.fn(async () => ({
      found: true,
      page: { slug: 'a', title: 'A', summary: 'sa', tags: [], updatedAt: '2026-01-01' },
      outgoing: [], backlinks: [], sources: [],
      health: { brokenLinks: 0, inboundCount: 0, outboundCount: 0, sourceCount: 0 },
    }));
    const out = await wikiInspectTool.handler({ slug: 'a', include: ['health'] }, fakeCtx({ inspectPage }));
    expect(inspectPage).toHaveBeenCalledWith('a', ['health']);
    expect(out.page).not.toHaveProperty('markdown');
  });
});

describe('source.search', () => {
  it('对每个返回 chunk 记录来源访问', async () => {
    const onSourceAccess = vi.fn();
    const searchSources = vi.fn(async () => ({
      hits: [{
        sourceId: 'src1', filename: 'a.md', chunkId: 'c0', heading: 'H',
        excerpt: 'secret', score: 2,
      }],
    }));
    const out = await sourceSearchTool.handler(
      { query: 'secret' },
      fakeCtx({ searchSources, onSourceAccess }),
    );
    expect(out.hits).toHaveLength(1);
    expect(onSourceAccess).toHaveBeenCalledWith({ sourceId: 'src1', chunkId: 'c0' });
  });

  it('Schema 拒绝空查询与越界 limit', () => {
    expect(sourceSearchTool.inputSchema.safeParse({ query: ' ' }).success).toBe(false);
    expect(sourceSearchTool.inputSchema.safeParse({ query: 'q', limit: 11 }).success).toBe(false);
  });
});

describe('source.read', () => {
  it('成功读取后记录来源标识', async () => {
    const onSourceAccess = vi.fn();
    const readSource = vi.fn(async () => ({
      sourceId: 'src1', filename: 'a.md', chunkId: 'c0', content: 'secret',
      nextOffset: null, truncated: false,
    }));
    const out = await sourceReadTool.handler(
      { sourceId: 'src1', chunkId: 'c0' },
      fakeCtx({ readSource, onSourceAccess }),
    );
    expect(out.content).toBe('secret');
    expect(onSourceAccess).toHaveBeenCalledWith({ sourceId: 'src1', chunkId: 'c0' });
  });

  it('Schema 拒绝负 offset 与过大 limit', () => {
    expect(sourceReadTool.inputSchema.safeParse({ sourceId: 's', offset: -1 }).success).toBe(false);
    expect(sourceReadTool.inputSchema.safeParse({ sourceId: 's', limit: 20_001 }).success).toBe(false);
  });
});
