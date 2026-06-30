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
  executePageUpdate: vi.fn(async (_j: string, _s: unknown, input: { slug: string }) => ({ updatedSlug: input.slug })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'new-page' })),
}));
vi.mock('@/server/wiki/page-ops', () => opsMocks);

import { buildFixToolContext } from '../fix-tools';
import { createFixGuard } from '../fix-deterministic';

const subject = { id: 's1', slug: 'general', name: 'G', description: '', createdAt: '', updatedAt: '' } as never;

describe('buildFixToolContext', () => {
  beforeEach(() => {
    opsMocks.executePageUpdate.mockClear();
    opsMocks.executePageCreate.mockClear();
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
  });

  it('create：成功调内核 + record + emit fix:create', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    const res = await ctx.createPage!({ title: 'New Page', body: 'content' });
    expect(res.createdSlug).toBe('new-page');
    expect(guard.totals().create).toBe(1);
    expect(emit).toHaveBeenCalledWith('fix:create', expect.any(String), expect.objectContaining({ slug: 'new-page' }));
  });
});
