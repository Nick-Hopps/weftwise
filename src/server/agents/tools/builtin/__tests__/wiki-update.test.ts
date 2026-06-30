import { describe, it, expect, vi } from 'vitest';
import { wikiUpdateTool } from '../wiki-update';
import type { ToolContext } from '../../tool-context';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    subject: { id: 's1', slug: 'general', name: 'G', description: '', createdAt: '', updatedAt: '' },
    readPage: vi.fn(async () => null),
    search: vi.fn(async () => []),
    listPages: vi.fn(async () => []),
    ...over,
  } as ToolContext;
}

describe('wiki.update tool', () => {
  it('注入 updatePage → ok:true 返回 updatedSlug', async () => {
    const updatePage = vi.fn(async () => ({ updatedSlug: 'eigen' }));
    const res = await wikiUpdateTool.handler({ slug: 'eigen', body: 'x' }, ctx({ updatePage }));
    expect(res.ok).toBe(true);
    expect(res.updatedSlug).toBe('eigen');
    expect(updatePage).toHaveBeenCalledWith({ slug: 'eigen', body: 'x' });
  });
  it('ctx 缺 updatePage → ok:false 优雅报错', async () => {
    const res = await wikiUpdateTool.handler({ slug: 'eigen', body: 'x' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not available/i);
  });
  it('updatePage 抛错 → ok:false 透传消息', async () => {
    const updatePage = vi.fn(async () => { throw new Error('update would leave unresolved wikilink(s): [[Ghost]]'); });
    const res = await wikiUpdateTool.handler({ slug: 'eigen', body: '[[Ghost]]' }, ctx({ updatePage }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/unresolved wikilink/i);
  });
});
