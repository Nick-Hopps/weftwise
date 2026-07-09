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
    const updatePage = vi.fn(async () => ({ updatedSlug: 'eigen', referencesUpdated: 0 }));
    const res = await wikiUpdateTool.handler({ slug: 'eigen', body: 'x', summary: 's', tags: ['math'] }, ctx({ updatePage }));
    expect(res.ok).toBe(true);
    expect(res.updatedSlug).toBe('eigen');
    expect(updatePage).toHaveBeenCalledWith({ slug: 'eigen', body: 'x', summary: 's', tags: ['math'] });
  });

  it('传 title → 透传给 updatePage，返回 referencesUpdated', async () => {
    const updatePage = vi.fn(async () => ({ updatedSlug: 'eigenvalue', referencesUpdated: 2 }));
    const res = await wikiUpdateTool.handler(
      { slug: 'eigenvalue', title: 'Eigen Value', body: 'x' },
      ctx({ updatePage }),
    );
    expect(res.ok).toBe(true);
    expect(res.referencesUpdated).toBe(2);
    expect(res.message).toContain('2 references updated');
    expect(updatePage).toHaveBeenCalledWith({ slug: 'eigenvalue', title: 'Eigen Value', body: 'x' });
  });

  it('referencesUpdated=0 时 message 不提 references', async () => {
    const updatePage = vi.fn(async () => ({ updatedSlug: 'eigenvalue', referencesUpdated: 0 }));
    const res = await wikiUpdateTool.handler({ slug: 'eigenvalue', body: 'x' }, ctx({ updatePage }));
    expect(res.message).not.toContain('references updated');
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
