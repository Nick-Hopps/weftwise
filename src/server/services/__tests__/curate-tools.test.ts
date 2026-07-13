import { describe, it, expect, beforeEach, vi } from 'vitest';

const opsMocks = vi.hoisted(() => ({
  executePageMerge: vi.fn(async () => ({ mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 1 })),
  executePageSplit: vi.fn(async () => ({ sourceSlug: 'a', pageSlugs: ['a', 'a-2'], primarySlug: 'a', referencesRepointed: 0 })),
  executePageDelete: vi.fn(async () => ({ deletedSlug: 'x', brokenBacklinks: 0 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'new' })),
  executePageMetadataPatch: vi.fn(async (_j: string, _s: unknown, input: { slug: string }) => ({
    updatedSlug: input.slug,
    referencesUpdated: 0,
    changedFields: ['summary'],
  })),
  executePageLinkEnsure: vi.fn(async (_j: string, _s: unknown, input: {
    sourceSlug: string;
    targetSubjectSlug?: string;
    targetSlug: string;
    mode: 'link' | 'unlink' | 'retarget';
  }) => ({
    updatedSlug: input.sourceSlug,
    mode: input.mode,
    targetSubjectSlug: input.targetSubjectSlug ?? 'general',
    targetSlug: input.targetSlug,
  })),
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
  const guard = createCurateGuard({ seedSet, allowedSet, caps: { merge: 5, split: 5, delete: 5, create: 5, update: 5 } });
  return { ctx: buildCurateToolContext(subject, { guard, jobId: 'j1', emit }), emit, guard };
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

  it('metadataPatch：source 在 allowedSet 时直接执行、记录 update 并 emit', async () => {
    const { ctx, emit, guard } = ctxWith(new Set(['a']), new Set(['a', 'b']));

    await expect(ctx.metadataPatch!({ slug: 'b', summary: '新的摘要' })).resolves.toMatchObject({
      updatedSlug: 'b',
      changedFields: ['summary'],
    });
    expect(opsMocks.executePageMetadataPatch).toHaveBeenCalledWith(
      'j1', subject, { slug: 'b', summary: '新的摘要' },
    );
    expect(guard.totals()).toMatchObject({ update: 1, writes: 1 });
    expect(emit).toHaveBeenCalledWith(
      'curate:update',
      expect.any(String),
      expect.objectContaining({ slug: 'b' }),
    );
  });

  it('metadataPatch：source 在 allowedSet 外时不执行内核', async () => {
    const { ctx, guard } = ctxWith(null, new Set(['inside']));

    await expect(ctx.metadataPatch!({ slug: 'outside', tags: ['x'] }))
      .rejects.toThrow(/allowed scope/);
    expect(opsMocks.executePageMetadataPatch).not.toHaveBeenCalled();
    expect(guard.totals()).toMatchObject({ update: 0, writes: 0 });
  });

  it('linkEnsure：只校验 source，允许 allowedSet 外与跨主题 target', async () => {
    const { ctx, guard } = ctxWith(new Set(['inside']), new Set(['inside']));
    const input = {
      sourceSlug: 'inside',
      targetSubjectSlug: 'other-subject',
      targetSlug: 'outside-target',
      oldString: '现有唯一锚点',
      mode: 'link' as const,
    };

    await expect(ctx.linkEnsure!(input)).resolves.toMatchObject({
      updatedSlug: 'inside',
      targetSubjectSlug: 'other-subject',
      targetSlug: 'outside-target',
    });
    expect(opsMocks.executePageLinkEnsure).toHaveBeenCalledWith('j1', subject, input);
    expect(guard.totals()).toMatchObject({ update: 1, writes: 1 });
  });

  it('linkEnsure：source 在 allowedSet 外时不执行内核', async () => {
    const { ctx, guard } = ctxWith(null, new Set(['inside']));

    await expect(ctx.linkEnsure!({
      sourceSlug: 'outside',
      targetSlug: 'inside',
      oldString: 'inside',
      mode: 'link',
    })).rejects.toThrow(/allowed scope/);
    expect(opsMocks.executePageLinkEnsure).not.toHaveBeenCalled();
    expect(guard.totals()).toMatchObject({ update: 0, writes: 0 });
  });

  it('并发窄写在 update cap=1 下完整串行，只有首个底层写成功', async () => {
    const emit = vi.fn();
    const guard = createCurateGuard({
      seedSet: null,
      allowedSet: new Set(['a']),
      caps: { merge: 5, split: 5, delete: 5, create: 5, update: 1 },
    });
    const ctx = buildCurateToolContext(subject, { guard, jobId: 'j1', emit });
    let release: (() => void) | undefined;
    opsMocks.executePageMetadataPatch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { updatedSlug: 'a', referencesUpdated: 0, changedFields: ['summary'] };
    });

    const first = ctx.metadataPatch!({ slug: 'a', summary: '新摘要' });
    const second = ctx.linkEnsure!({
      sourceSlug: 'a', targetSlug: 'b', oldString: 'B', mode: 'link',
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release!();
    const settled = await Promise.allSettled([first, second]);

    expect(settled[0]).toMatchObject({ status: 'fulfilled' });
    expect(settled[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/limit of 1 updates/) }),
    });
    expect(opsMocks.executePageMetadataPatch).toHaveBeenCalledOnce();
    expect(opsMocks.executePageLinkEnsure).not.toHaveBeenCalled();
    expect(guard.totals()).toMatchObject({ update: 1, writes: 1 });
  });

  it('首个写失败会释放串行队列，后续写可执行且仅后者计数', async () => {
    const order: string[] = [];
    opsMocks.executePageMetadataPatch.mockImplementationOnce(async () => {
      order.push('metadata:start');
      await Promise.resolve();
      order.push('metadata:fail');
      throw new Error('metadata failed');
    });
    opsMocks.executePageLinkEnsure.mockImplementationOnce(async (_j, _s, input) => {
      order.push('link:start');
      return {
        updatedSlug: input.sourceSlug,
        mode: input.mode,
        targetSubjectSlug: input.targetSubjectSlug ?? 'general',
        targetSlug: input.targetSlug,
      };
    });
    const { ctx, guard } = ctxWith(null, new Set(['a']));

    const settled = await Promise.allSettled([
      ctx.metadataPatch!({ slug: 'a', summary: '新摘要' }),
      ctx.linkEnsure!({ sourceSlug: 'a', targetSlug: 'b', oldString: 'B', mode: 'link' }),
    ]);

    expect(settled.map((item) => item.status)).toEqual(['rejected', 'fulfilled']);
    expect(order).toEqual(['metadata:start', 'metadata:fail', 'link:start']);
    expect(guard.totals()).toMatchObject({ update: 1, writes: 1 });
  });

  it('注入当前 Subject 的 inspect/source/list 证据能力', () => {
    const { ctx } = ctxWith(null);
    expect(ctx.inspectPage).toBeTypeOf('function');
    expect(ctx.searchSources).toBeTypeOf('function');
    expect(ctx.readSource).toBeTypeOf('function');
    expect(ctx.listPages).toBeTypeOf('function');
  });
});
