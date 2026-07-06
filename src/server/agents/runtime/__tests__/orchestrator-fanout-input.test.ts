import { describe, it, expect, vi } from 'vitest';
import { buildFanoutInput, selectRelevantExistingPagesForFanout, EXISTING_PAGES_FANOUT_TOP_K } from '../orchestrator';

// buildFanoutInput 仅用到 ctx.emit 与 ctx.chunkStore（item.sourceRefs 为空时不读 chunkStore）
function stubCtx(overrides: Record<string, unknown> = {}): any {
  return { emit: () => {}, chunkStore: new Map(), subject: { id: 'subj-1' }, ...overrides };
}

function manyExistingPages(n: number): Array<{ slug: string; title: string; summary: string }> {
  return Array.from({ length: n }, (_, i) => ({ slug: `page-${i}`, title: `Page ${i}`, summary: `about page ${i}` }));
}

describe('buildFanoutInput', () => {
  it('把 expositionDirective 与 augmentationDirective 一并注入每页输入', async () => {
    const carry = {
      subjectSlug: 'general',
      existingPages: [],
      plan: { pages: [] },
      languageDirective: 'LANG',
      augmentationDirective: 'AUG',
      expositionDirective: 'EXPO',
    };
    const item = { slug: 'foo', title: 'Foo', sourceRefs: [] };
    const out = (await buildFanoutInput(carry, item, stubCtx(), {})) as Record<string, unknown>;
    expect(out.expositionDirective).toBe('EXPO');
    expect(out.augmentationDirective).toBe('AUG');
    expect(out.slug).toBe('foo');
  });

  // T2.2：大库场景下 existingPages 注入须裁剪为相关子集，而不是整份透传。
  it('T2.2: 大库场景下每页注入的 existingPages 条数有界（≤ topK + 引用数 + 自身）', async () => {
    const existingPages = manyExistingPages(150);
    const retrieveRelevantPages = vi.fn().mockResolvedValue(
      existingPages.slice(0, EXISTING_PAGES_FANOUT_TOP_K).map((p) => p.slug),
    );
    const carry = {
      subjectSlug: 'general',
      existingPages,
      plan: { pages: [] },
    };
    const item = { slug: 'brand-new', title: 'Brand New', summary: 'no links here', sourceRefs: [] };
    const out = (await buildFanoutInput(carry, item, stubCtx({ retrieveRelevantPages }), {})) as Record<string, unknown>;
    const subset = out.existingPages as Array<{ slug: string }>;
    expect(subset.length).toBeLessThanOrEqual(EXISTING_PAGES_FANOUT_TOP_K + 1);
    expect(subset.length).toBeLessThan(existingPages.length);
    expect(retrieveRelevantPages).toHaveBeenCalledWith('subj-1', expect.any(String), EXISTING_PAGES_FANOUT_TOP_K);
  });

  it('T2.2: update 页（slug 命中 existingPages）自身条目必在子集中', async () => {
    const existingPages = manyExistingPages(100);
    const retrieveRelevantPages = vi.fn().mockResolvedValue([]); // 检索命中为空
    const carry = { subjectSlug: 'general', existingPages, plan: { pages: [] } };
    const item = { slug: 'page-42', title: 'Page 42', summary: 'updated content', sourceRefs: [] };
    const out = (await buildFanoutInput(carry, item, stubCtx({ retrieveRelevantPages }), {})) as Record<string, unknown>;
    const subset = out.existingPages as Array<{ slug: string }>;
    expect(subset.some((p) => p.slug === 'page-42')).toBe(true);
  });

  it('T2.2: wikilink 目标页必在子集中（即使检索未命中）', async () => {
    const existingPages = manyExistingPages(100);
    const retrieveRelevantPages = vi.fn().mockResolvedValue([]);
    const carry = { subjectSlug: 'general', existingPages, plan: { pages: [] } };
    const item = { slug: 'brand-new', title: 'Brand New', summary: 'See [[Page 7]] for context', sourceRefs: [] };
    const out = (await buildFanoutInput(carry, item, stubCtx({ retrieveRelevantPages }), {})) as Record<string, unknown>;
    const subset = out.existingPages as Array<{ slug: string }>;
    expect(subset.some((p) => p.slug === 'page-7')).toBe(true);
  });

  it('T2.2: 检索函数抛错时回落最小集合（自身+wikilink目标），不使 fanout 失败', async () => {
    const existingPages = manyExistingPages(50);
    const retrieveRelevantPages = vi.fn().mockRejectedValue(new Error('fts 挂了'));
    const emit = vi.fn();
    const carry = { subjectSlug: 'general', existingPages, plan: { pages: [] } };
    const item = { slug: 'page-3', title: 'Page 3', summary: 'See [[Page 9]]', sourceRefs: [] };
    const out = (await buildFanoutInput(carry, item, stubCtx({ retrieveRelevantPages, emit }), {})) as Record<string, unknown>;
    const subset = out.existingPages as Array<{ slug: string }>;
    expect(subset.some((p) => p.slug === 'page-3')).toBe(true);
    expect(subset.some((p) => p.slug === 'page-9')).toBe(true);
    expect(emit).toHaveBeenCalledWith('ingest:warn', expect.stringContaining('existingPages retrieval failed'), expect.any(Object));
  });

  it('T2.2: existingPages 为空时直接返回空，不调用检索', async () => {
    const retrieveRelevantPages = vi.fn();
    const out = await selectRelevantExistingPagesForFanout({
      ctx: stubCtx({ retrieveRelevantPages }),
      item: { slug: 'foo' },
      existingPages: [],
    });
    expect(out).toEqual([]);
    expect(retrieveRelevantPages).not.toHaveBeenCalled();
  });
});
