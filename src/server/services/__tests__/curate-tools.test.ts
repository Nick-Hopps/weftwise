import { describe, it, expect, beforeEach, vi } from 'vitest';

const opsMocks = vi.hoisted(() => ({
  executePageMerge: vi.fn(async () => ({ mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 1 })),
  executePageSplit: vi.fn(async () => ({ sourceSlug: 'a', pageSlugs: ['a', 'a-2'], primarySlug: 'a', referencesRepointed: 0 })),
  executePageDelete: vi.fn(async () => ({ deletedSlug: 'x', brokenBacklinks: 0 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'new' })),
}));
vi.mock('@/server/wiki/page-ops', () => opsMocks);
// 读侧依赖（本测试只测写侧，给最小桩）
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: vi.fn(() => null), getAllPages: vi.fn(() => []), isMetaPage: () => false,
}));
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));
vi.mock('@/server/wiki/wiki-store', () => ({ readPageInSubject: vi.fn(() => null) }));

import { buildCurateToolContext } from '../curate-tools';
import { createCurateGuard } from '@/server/wiki/curate-plan';

const subject = { id: 's1', slug: 'general', name: 'G', description: '', createdAt: '', updatedAt: '' } as never;

function ctxWith(seedSet: Set<string> | null) {
  const emit = vi.fn();
  const guard = createCurateGuard({ seedSet, caps: { merge: 5, split: 5, delete: 5, create: 5 } });
  return { ctx: buildCurateToolContext(subject, { guard, jobId: 'j1', emit }), emit };
}

describe('buildCurateToolContext write capabilities', () => {
  beforeEach(() => { Object.values(opsMocks).forEach((m) => m.mockClear()); });
  it('mergePages 通过 guard → 执行 + emit curate:merge', async () => {
    const { ctx, emit } = ctxWith(null);
    const res = await ctx.mergePages!('a', 'b');
    expect(opsMocks.executePageMerge).toHaveBeenCalledWith('j1', subject, { targetSlug: 'a', sourceSlug: 'b' });
    expect(emit).toHaveBeenCalledWith('curate:merge', expect.any(String), expect.any(Object));
    expect(res).toEqual({ mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 1 });
  });
  it('guard 拒（保护页）→ emit curate:skip 且抛错，不执行', async () => {
    const { ctx, emit } = ctxWith(null);
    await expect(ctx.mergePages!('index', 'b')).rejects.toThrow(/protected/);
    expect(opsMocks.executePageMerge).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('curate:skip', expect.stringContaining('protected'), expect.any(Object));
  });
  it('auto（seedSet）createPage 被 guard 拒', async () => {
    const { ctx } = ctxWith(new Set(['a']));
    await expect(ctx.createPage!({ title: 'X', body: 'y' })).rejects.toThrow(/manual curation/);
    expect(opsMocks.executePageCreate).not.toHaveBeenCalled();
  });
  it('splitPage 通过 → 执行 + 返回 primary/pages + emit curate:split', async () => {
    const { ctx, emit } = ctxWith(null);
    const res = await ctx.splitPage!('a', 'hint');
    expect(opsMocks.executePageSplit).toHaveBeenCalledWith('j1', subject, { sourceSlug: 'a', hint: 'hint' });
    expect(res).toEqual({ primarySlug: 'a', pageSlugs: ['a', 'a-2'], referencesRepointed: 0 });
    expect(emit).toHaveBeenCalledWith('curate:split', expect.any(String), expect.any(Object));
  });
  it('deletePage 通过 → 执行 + emit curate:delete', async () => {
    const { ctx, emit } = ctxWith(null);
    await ctx.deletePage!('x');
    expect(opsMocks.executePageDelete).toHaveBeenCalledWith('j1', subject, 'x');
    expect(emit).toHaveBeenCalledWith('curate:delete', expect.any(String), expect.any(Object));
  });
});
