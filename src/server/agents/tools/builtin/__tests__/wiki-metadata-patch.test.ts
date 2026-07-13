import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../tool-context';
import { wikiMetadataPatchTool } from '../wiki-metadata-patch';

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  subject: { id: 's1', slug: 'general', name: 'General' },
  readPage: vi.fn(), search: vi.fn(), listPages: vi.fn(), ...extra,
}) as never;

describe('wiki.metadata.patch tool', () => {
  it('schema 严格限制为 metadata contract 且至少包含一个可编辑字段', () => {
    expect(wikiMetadataPatchTool.inputSchema.safeParse({ slug: 'page-a', tags: ['math'] }).success)
      .toBe(true);
    expect(wikiMetadataPatchTool.inputSchema.safeParse({ slug: 'page-a' }).success).toBe(false);
    expect(wikiMetadataPatchTool.inputSchema.safeParse({ slug: 'page-a', body: 'forbidden' }).success)
      .toBe(false);
    expect(wikiMetadataPatchTool.inputSchema.safeParse({
      slug: 'page-a', title: 'T', unknown: true,
    }).success).toBe(false);
  });

  it.each([
    ['重复 tags', { tags: Array(33).fill('math') }],
    ['重复 aliases', { aliases: Array(33).fill('Eigen Value') }],
    ['空白 tags', { tags: Array(33).fill('   ') }],
    ['空白 aliases', { aliases: Array(33).fill('   ') }],
  ])('raw array 超过 32 项时仍把 %s 交给核心规范化', (_label, fields) => {
    expect(wikiMetadataPatchTool.inputSchema.safeParse({ slug: 'page-a', ...fields }).success)
      .toBe(true);
  });

  it('sideEffect=update，execute 只委托 metadataPatch 能力', async () => {
    expect(wikiMetadataPatchTool.sideEffect).toBe('update');
    expect(wikiMetadataPatchTool.description).toMatch(/metadata|body unchanged/i);
    const metadataPatch = vi.fn(async () => ({
      updatedSlug: 'page-a', referencesUpdated: 2, changedFields: ['title' as const],
    }));
    const input = { slug: 'page-a', title: 'New title' };
    const result = await wikiMetadataPatchTool.handler(input, ctx({ metadataPatch }));
    expect(metadataPatch).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      ok: true, updatedSlug: 'page-a', referencesUpdated: 2, changedFields: ['title'],
    });
  });

  it('能力缺失或执行失败时返回 ok:false', async () => {
    expect((await wikiMetadataPatchTool.handler(
      { slug: 'page-a', tags: ['x'] }, ctx(),
    )).ok).toBe(false);
    const metadataPatch = vi.fn(async () => { throw new Error('metadata conflict'); });
    const result = await wikiMetadataPatchTool.handler(
      { slug: 'page-a', tags: ['x'] }, ctx({ metadataPatch }),
    );
    expect(result).toMatchObject({ ok: false, message: 'metadata conflict' });
  });
});
