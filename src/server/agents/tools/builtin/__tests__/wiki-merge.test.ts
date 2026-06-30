import { describe, it, expect, vi } from 'vitest';
import { wikiMergeTool } from '../wiki-merge';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.merge tool', () => {
  it('能力存在 → 合并并返回 ok + 计数', async () => {
    const mergePages = vi.fn().mockResolvedValue({ mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 2 });
    const out = await wikiMergeTool.handler({ targetSlug: 'a', sourceSlug: 'b' }, { ...baseCtx, mergePages });
    expect(mergePages).toHaveBeenCalledWith('a', 'b');
    expect(out).toEqual(expect.objectContaining({ ok: true, mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 2 }));
    expect(out.message).toContain('a');
  });
  it('能力缺失 → ok:false 不抛', async () => {
    const out = await wikiMergeTool.handler({ targetSlug: 'a', sourceSlug: 'b' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.mergedSlug).toBeNull();
  });
  it('抛错（如 guard 拒）→ ok:false + message', async () => {
    const mergePages = vi.fn().mockRejectedValue(new Error('reached the limit of 5 merges'));
    const out = await wikiMergeTool.handler({ targetSlug: 'a', sourceSlug: 'b' }, { ...baseCtx, mergePages });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/limit of 5 merges/);
  });
});
