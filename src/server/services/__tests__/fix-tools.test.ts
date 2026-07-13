import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoMocks = vi.hoisted(() => ({
  getPageBySlug: vi.fn(() => ({ slug: 'eigen', title: 'Eigen', summary: '', tags: [] })),
  getAllPages: vi.fn(() => [] as Array<{ slug: string; title: string; summary: string; tags: string[] }>),
  isMetaPage: vi.fn(() => false),
}));
vi.mock('@/server/db/repos/pages-repo', () => repoMocks);
const LONG = 'a fairly long original body with more than enough characters to matter here';
const storeMocks = vi.hoisted(() => ({ readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'Eigen' }, body: 'a fairly long original body with more than enough characters to matter here' })) }));
vi.mock('@/server/wiki/wiki-store', () => storeMocks);
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));
const opsMocks = vi.hoisted(() => ({
  executePageUpdate: vi.fn(async (_j: string, _s: unknown, input: { slug: string }) => ({ updatedSlug: input.slug, referencesUpdated: 0 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'new-page' })),
  executePagePatch: vi.fn(async (_j: string, _s: unknown, input: { slug: string; edits: unknown[] }) => ({ updatedSlug: input.slug, appliedEdits: input.edits.length })),
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
vi.mock('@/server/wiki/page-ops', () => opsMocks);

import { buildFixToolContext } from '../fix-tools';
import { createFixGuard } from '../fix-deterministic';

const subject = { id: 's1', slug: 'general', name: 'G', description: '', createdAt: '', updatedAt: '' } as never;

describe('buildFixToolContext', () => {
  beforeEach(() => {
    opsMocks.executePageUpdate.mockClear();
    opsMocks.executePageCreate.mockClear();
    opsMocks.executePagePatch.mockClear();
    opsMocks.executePageLinkEnsure.mockClear();
    storeMocks.readPageInSubject.mockReturnValue({ frontmatter: { title: 'Eigen' }, body: LONG });
  });

  it('update：成功调内核 + record + emit fix:page', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    const res = await ctx.updatePage!({ slug: 'eigen', body: `${LONG}, edited` });
    expect(res.updatedSlug).toBe('eigen');
    expect(opsMocks.executePageUpdate).toHaveBeenCalledOnce();
    expect(guard.totals().update).toBe(1);
    expect(emit).toHaveBeenCalledWith('fix:page', expect.any(String), expect.objectContaining({ slug: 'eigen' }));
  });

  it('update：title 原样透传给内核（fix 侧无需改代码，接口扩展自动生效）', async () => {
    const emit = vi.fn();
    opsMocks.executePageUpdate.mockResolvedValueOnce({ updatedSlug: 'eigen', referencesUpdated: 3 });
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    const res = await ctx.updatePage!({ slug: 'eigen', title: 'Eigen Value', body: `${LONG}, edited` });
    expect(res.referencesUpdated).toBe(3);
    expect(opsMocks.executePageUpdate).toHaveBeenCalledWith('j1', subject, { slug: 'eigen', title: 'Eigen Value', body: `${LONG}, edited` });
  });

  it('update：保护页 → fix:skip + 抛错，不调内核', async () => {
    const emit = vi.fn();
    const ctx = buildFixToolContext(subject, { guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit });
    await expect(ctx.updatePage!({ slug: 'index', body: 'x' })).rejects.toThrow(/protected/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:skip', expect.any(String), expect.objectContaining({ slug: 'index' }));
  });

  it('update：正文塌缩 >50% → fix:warn + 抛错，不调内核', async () => {
    const emit = vi.fn();
    const ctx = buildFixToolContext(subject, { guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit });
    await expect(ctx.updatePage!({ slug: 'eigen', body: 'tiny' })).rejects.toThrow(/dropped too much/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:warn', expect.any(String), expect.any(Object));
  });

  it('update：写 cap 耗尽 → fix:skip + 抛错', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 1 } });
    guard.record('update');
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    await expect(ctx.updatePage!({ slug: 'eigen', body: `${LONG}, edited` })).rejects.toThrow(/limit of 1 edits/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:skip', expect.any(String), expect.objectContaining({ slug: 'eigen' }));
  });

  it('update：目标页不存在 → fix:skip + 抛错，不调内核', async () => {
    const emit = vi.fn();
    storeMocks.readPageInSubject.mockReturnValueOnce(null as never);
    const ctx = buildFixToolContext(subject, { guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit });
    await expect(ctx.updatePage!({ slug: 'ghost', body: `${LONG}, edited` })).rejects.toThrow(/not found/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:skip', expect.any(String), expect.objectContaining({ slug: 'ghost' }));
  });

  it('patchPage：允许时调 executePagePatch 并 record/emit（不做忠实度检查）', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    const res = await ctx.patchPage!({ slug: 'eigen', edits: [{ oldString: 'a', newString: 'b' }] });
    expect(res.updatedSlug).toBe('eigen');
    expect(res.appliedEdits).toBe(1);
    expect(opsMocks.executePagePatch).toHaveBeenCalledWith('j1', subject, { slug: 'eigen', edits: [{ oldString: 'a', newString: 'b' }] });
    expect(guard.totals().update).toBe(1);
    expect(emit).toHaveBeenCalledWith('fix:page', expect.any(String), expect.objectContaining({ slug: 'eigen' }));
  });

  it('patchPage：写 cap 耗尽 → fix:skip + 抛错，不触内核', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 1 } });
    guard.record('update');
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    await expect(ctx.patchPage!({ slug: 'eigen', edits: [{ oldString: 'a', newString: 'b' }] })).rejects.toThrow(/limit of 1 edits/);
    expect(opsMocks.executePagePatch).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:skip', expect.any(String), expect.objectContaining({ slug: 'eigen' }));
  });

  it('patchPage：保护页 → fix:skip + 抛错，不触内核', async () => {
    const emit = vi.fn();
    const ctx = buildFixToolContext(subject, { guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit });
    await expect(ctx.patchPage!({ slug: 'index', edits: [{ oldString: 'a', newString: 'b' }] })).rejects.toThrow(/protected/);
    expect(opsMocks.executePagePatch).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:skip', expect.any(String), expect.objectContaining({ slug: 'index' }));
  });

  it('不注入 createPage（fix 禁止补建 stub 页）', () => {
    const ctx = buildFixToolContext(subject, { guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit: vi.fn() });
    expect(ctx.createPage).toBeUndefined();
  });

  it('linkEnsure：Guard 放行后直接调用内核，并记录 update 与 emit', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    const input = {
      sourceSlug: 'eigen',
      targetSlug: 'matrix',
      oldString: 'matrix',
      displayText: 'matrix',
      mode: 'link' as const,
    };

    await expect(ctx.linkEnsure!(input)).resolves.toMatchObject({
      updatedSlug: 'eigen',
      targetSlug: 'matrix',
    });
    expect(opsMocks.executePageLinkEnsure).toHaveBeenCalledWith('j1', subject, input);
    expect(guard.totals()).toMatchObject({ update: 1, writes: 1 });
    expect(emit).toHaveBeenCalledWith(
      'fix:page',
      expect.any(String),
      expect.objectContaining({ slug: 'eigen' }),
    );
  });

  it('linkEnsure：Guard 拒绝保护页时不调用内核、不计数', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });

    await expect(ctx.linkEnsure!({
      sourceSlug: 'index',
      targetSlug: 'matrix',
      oldString: 'matrix',
      mode: 'link',
    })).rejects.toThrow(/protected/);

    expect(opsMocks.executePageLinkEnsure).not.toHaveBeenCalled();
    expect(guard.totals()).toMatchObject({ update: 0, writes: 0 });
    expect(emit).toHaveBeenCalledWith(
      'fix:skip',
      expect.any(String),
      expect.objectContaining({ slug: 'index' }),
    );
  });

  it('linkEnsure：写 cap 耗尽时不调用内核', async () => {
    const guard = createFixGuard({ caps: { writes: 1 } });
    guard.record('update');
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit: vi.fn() });

    await expect(ctx.linkEnsure!({
      sourceSlug: 'eigen',
      targetSlug: 'matrix',
      oldString: 'matrix',
      mode: 'link',
    })).rejects.toThrow(/limit of 1 edits/);
    expect(opsMocks.executePageLinkEnsure).not.toHaveBeenCalled();
  });

  it('Fix 不注入 metadataPatch', () => {
    const ctx = buildFixToolContext(subject, {
      guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit: vi.fn(),
    });
    expect(ctx.metadataPatch).toBeUndefined();
  });

  it('并发写在 writes cap=1 下完整串行，不会突破 FixGuard', async () => {
    const guard = createFixGuard({ caps: { writes: 1 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit: vi.fn() });
    let release: (() => void) | undefined;
    opsMocks.executePagePatch.mockImplementationOnce(async (_j, _s, input) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { updatedSlug: input.slug, appliedEdits: input.edits.length };
    });

    const first = ctx.patchPage!({ slug: 'eigen', edits: [{ oldString: 'a', newString: 'b' }] });
    const second = ctx.linkEnsure!({
      sourceSlug: 'eigen', targetSlug: 'matrix', oldString: 'matrix', mode: 'link',
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release!();
    const settled = await Promise.allSettled([first, second]);

    expect(settled[0]).toMatchObject({ status: 'fulfilled' });
    expect(settled[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringMatching(/limit of 1 edits/) }),
    });
    expect(opsMocks.executePagePatch).toHaveBeenCalledOnce();
    expect(opsMocks.executePageLinkEnsure).not.toHaveBeenCalled();
    expect(guard.totals()).toMatchObject({ update: 1, writes: 1 });
  });

  it('注入当前 Subject 的 inspect/source/list 证据能力', () => {
    const ctx = buildFixToolContext(subject, {
      guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit: vi.fn(),
    });
    expect(ctx.inspectPage).toBeTypeOf('function');
    expect(ctx.searchSources).toBeTypeOf('function');
    expect(ctx.readSource).toBeTypeOf('function');
    expect(ctx.listPages).toBeTypeOf('function');
  });
});
