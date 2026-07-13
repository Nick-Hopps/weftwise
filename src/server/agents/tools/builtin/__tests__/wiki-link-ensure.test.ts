import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../tool-context';
import { wikiLinkEnsureTool } from '../wiki-link-ensure';

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  subject: { id: 's1', slug: 'general', name: 'General' },
  readPage: vi.fn(), search: vi.fn(), listPages: vi.fn(), ...extra,
}) as never;

describe('wiki.link.ensure tool', () => {
  const input = {
    sourceSlug: 'source', targetSubjectSlug: 'other', targetSlug: 'target',
    oldString: 'visible anchor', displayText: 'anchor', mode: 'link' as const,
  };

  it('schema 严格对应 LinkEnsureInput', () => {
    expect(wikiLinkEnsureTool.inputSchema.safeParse(input).success).toBe(true);
    expect(wikiLinkEnsureTool.inputSchema.safeParse({ ...input, mode: 'rewrite' }).success)
      .toBe(false);
    expect(wikiLinkEnsureTool.inputSchema.safeParse({ ...input, replacement: 'secret' }).success)
      .toBe(false);
  });

  it('sideEffect=update，execute 只委托 linkEnsure 能力', async () => {
    expect(wikiLinkEnsureTool.sideEffect).toBe('update');
    expect(wikiLinkEnsureTool.description).toMatch(/one|single|existing anchor/i);
    const linkEnsure = vi.fn(async () => ({
      updatedSlug: 'source', mode: 'link' as const,
      targetSubjectSlug: 'other', targetSlug: 'target',
    }));
    const result = await wikiLinkEnsureTool.handler(input, ctx({ linkEnsure }));
    expect(linkEnsure).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      ok: true, updatedSlug: 'source', mode: 'link',
      targetSubjectSlug: 'other', targetSlug: 'target',
    });
  });

  it('能力缺失或执行失败时返回 ok:false', async () => {
    expect((await wikiLinkEnsureTool.handler(input, ctx())).ok).toBe(false);
    const linkEnsure = vi.fn(async () => { throw new Error('anchor not found'); });
    const result = await wikiLinkEnsureTool.handler(input, ctx({ linkEnsure }));
    expect(result).toMatchObject({ ok: false, message: 'anchor not found' });
  });
});
