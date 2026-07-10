import { describe, it, expect, beforeEach, vi } from 'vitest';

const opsMocks = vi.hoisted(() => ({
  executePageMerge: vi.fn(async () => ({ mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 1 })),
  executePageSplit: vi.fn(async () => ({ sourceSlug: 'a', pageSlugs: ['a', 'a-2'], primarySlug: 'a', referencesRepointed: 0 })),
  executePageDelete: vi.fn(async () => ({ deletedSlug: 'x', brokenBacklinks: 0 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'new' })),
}));
const pagesMocks = vi.hoisted(() => ({
  getPageBySlug: vi.fn(() => ({ slug: 'inside', title: 'Inside', summary: '', tags: [] })),
  getAllPages: vi.fn(() => []),
  isMetaPage: vi.fn(() => false),
}));
const searchMock = vi.hoisted(() => vi.fn(async () => ['inside', 'outside']));
const readMock = vi.hoisted(() => vi.fn(() => ({ body: '正文' })));
vi.mock('@/server/wiki/page-ops', () => opsMocks);
// 读侧依赖（本测试只测写侧，给最小桩）
vi.mock('@/server/db/repos/pages-repo', () => pagesMocks);
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: searchMock }));
vi.mock('@/server/wiki/wiki-store', () => ({ readPageInSubject: readMock }));

import { buildCurateToolContext } from '../curate-tools';
import { createCurateGuard } from '@/server/wiki/curate-plan';

const subject = { id: 's1', slug: 'general', name: 'G', description: '', createdAt: '', updatedAt: '' } as never;

function ctxWith(seedSet: Set<string> | null, allowedSet = new Set(['a', 'b', 'x', 'inside'])) {
  const emit = vi.fn();
  const guard = createCurateGuard({ seedSet, allowedSet, caps: { merge: 5, split: 5, delete: 5, create: 5 } });
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

  it('scope 外 read 返回 null，search 过滤 scope 外结果', async () => {
    const { ctx } = ctxWith(new Set(['inside']), new Set(['inside']));
    expect(await ctx.readPage('outside')).toBeNull();
    expect(await ctx.readPage('inside')).toEqual({ title: 'Inside', markdown: '正文' });
    expect((await ctx.search('q', 8)).map((hit) => hit.slug)).toEqual(['inside']);
  });

  it('scope 外 merge/split/delete 均不执行 page-ops', async () => {
    const { ctx } = ctxWith(null, new Set(['inside']));
    await expect(ctx.mergePages!('inside', 'outside')).rejects.toThrow(/allowed scope/);
    await expect(ctx.splitPage!('outside')).rejects.toThrow(/allowed scope/);
    await expect(ctx.deletePage!('outside')).rejects.toThrow(/allowed scope/);
    expect(opsMocks.executePageMerge).not.toHaveBeenCalled();
    expect(opsMocks.executePageSplit).not.toHaveBeenCalled();
    expect(opsMocks.executePageDelete).not.toHaveBeenCalled();
  });
});
