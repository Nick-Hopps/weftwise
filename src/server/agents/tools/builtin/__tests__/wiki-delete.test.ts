import { describe, it, expect, vi } from 'vitest';
import { wikiDeleteTool } from '../wiki-delete';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.delete tool', () => {
  it('能力存在 → 删除并返回 ok + deletedSlug + 坏链提示', async () => {
    const deletePage = vi.fn().mockResolvedValue({ deletedSlug: 'eigen', brokenBacklinks: 3 });
    const out = await wikiDeleteTool.handler({ slug: 'eigen' }, { ...baseCtx, deletePage });
    expect(deletePage).toHaveBeenCalledWith('eigen');
    expect(out).toEqual(expect.objectContaining({ ok: true, deletedSlug: 'eigen', brokenBacklinks: 3 }));
    expect(out.message).toContain('eigen');
    expect(out.message).toMatch(/broken links/);
    expect(out.message).toMatch(/revert/i);
  });
  it('无坏链 → 消息不含坏链句', async () => {
    const deletePage = vi.fn().mockResolvedValue({ deletedSlug: 'eigen', brokenBacklinks: 0 });
    const out = await wikiDeleteTool.handler({ slug: 'eigen' }, { ...baseCtx, deletePage });
    expect(out.message).not.toMatch(/broken links/);
  });
  it('能力缺失 → ok:false，不抛', async () => {
    const out = await wikiDeleteTool.handler({ slug: 'x' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.deletedSlug).toBeNull();
  });
  it('执行抛错 → 捕获为 ok:false + message', async () => {
    const deletePage = vi.fn().mockRejectedValue(new Error('Cannot delete protected system page "index".'));
    const out = await wikiDeleteTool.handler({ slug: 'index' }, { ...baseCtx, deletePage });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/protected/);
  });
});
