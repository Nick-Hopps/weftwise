import { describe, it, expect, vi } from 'vitest';
import { wikiSplitTool } from '../wiki-split';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.split tool', () => {
  it('能力存在 → 拆分并返回 ok + primary/pages', async () => {
    const splitPage = vi.fn().mockResolvedValue({ primarySlug: 'a', pageSlugs: ['a', 'a-2'], referencesRepointed: 1 });
    const out = await wikiSplitTool.handler({ slug: 'a', hint: 'by topic' }, { ...baseCtx, splitPage });
    expect(splitPage).toHaveBeenCalledWith('a', 'by topic');
    expect(out).toEqual(expect.objectContaining({ ok: true, primarySlug: 'a', pageSlugs: ['a', 'a-2'] }));
  });
  it('能力缺失 → ok:false 不抛', async () => {
    const out = await wikiSplitTool.handler({ slug: 'a' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.primarySlug).toBeNull();
  });
  it('抛错 → ok:false + message', async () => {
    const splitPage = vi.fn().mockRejectedValue(new Error('split must produce at least 2 pages'));
    const out = await wikiSplitTool.handler({ slug: 'a' }, { ...baseCtx, splitPage });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/at least 2 pages/);
  });
});
