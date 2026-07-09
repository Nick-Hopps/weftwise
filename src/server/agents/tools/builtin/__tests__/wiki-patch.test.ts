import { describe, it, expect, vi } from 'vitest';
import { wikiPatchTool } from '../wiki-patch';
import type { ToolContext } from '../../tool-context';

const ctx = (extra: Partial<ToolContext> = {}): ToolContext =>
  ({ subject: { id: 's', slug: 'general', name: 'G' }, readPage: vi.fn(), search: vi.fn(), listPages: vi.fn(), ...extra }) as never;

describe('wiki.patch tool', () => {
  const edits = [{ oldString: 'a', newString: 'b' }];

  it('注入 patchPage → ok:true 返回 updatedSlug/appliedEdits', async () => {
    const patchPage = vi.fn(async () => ({ updatedSlug: 'eigen', appliedEdits: 2 }));
    const res = await wikiPatchTool.handler({ slug: 'eigen', edits }, ctx({ patchPage }));
    expect(res).toMatchObject({ ok: true, updatedSlug: 'eigen', appliedEdits: 2 });
    expect(patchPage).toHaveBeenCalledWith({ slug: 'eigen', edits });
  });

  it('ctx 缺 patchPage → ok:false 优雅报错', async () => {
    const res = await wikiPatchTool.handler({ slug: 'eigen', edits }, ctx());
    expect(res.ok).toBe(false);
  });

  it('patchPage 抛错 → ok:false 透传消息', async () => {
    const patchPage = vi.fn(async () => { throw new Error('edit #1: old_string not found'); });
    const res = await wikiPatchTool.handler({ slug: 'eigen', edits }, ctx({ patchPage }));
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not found');
  });
});
