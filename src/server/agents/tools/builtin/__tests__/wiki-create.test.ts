import { describe, it, expect, vi } from 'vitest';
import { wikiCreateTool } from '../wiki-create';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.create tool', () => {
  it('能力存在 → 创建并返回 ok + createdSlug', async () => {
    const createPage = vi.fn().mockResolvedValue({ createdSlug: 'foo-2' });
    const out = await wikiCreateTool.handler({ title: 'Foo', body: 'hi' }, { ...baseCtx, createPage });
    expect(createPage).toHaveBeenCalledWith({ title: 'Foo', body: 'hi' });
    expect(out).toEqual(expect.objectContaining({ ok: true, createdSlug: 'foo-2' }));
    expect(out.message).toContain('foo-2');
  });
  it('能力缺失 → ok:false，不抛', async () => {
    const out = await wikiCreateTool.handler({ title: 'X', body: 'y' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.createdSlug).toBeNull();
  });
  it('执行抛错 → 捕获为 ok:false + message', async () => {
    const createPage = vi.fn().mockRejectedValue(new Error('create changeset invalid: broken link'));
    const out = await wikiCreateTool.handler({ title: 'X', body: '[[Ghost]]' }, { ...baseCtx, createPage });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/invalid/);
  });
});
