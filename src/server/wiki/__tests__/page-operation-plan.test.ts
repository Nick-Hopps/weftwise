import { beforeEach, describe, expect, it, vi } from 'vitest';

const txMocks = vi.hoisted(() => ({
  createChangeset: vi.fn((jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: `cs-${jobId}`, jobId, subjectId: subject.id, subjectSlug: subject.slug, entries,
    preHead: '', postHead: null, status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(async (changeset: { id: string }) => ({ ...changeset, status: 'applied' })),
}));
vi.mock('../wiki-transaction', () => txMocks);

const gitMocks = vi.hoisted(() => ({ getVaultHead: vi.fn(async () => 'head-1') }));
vi.mock('../../git/git-service', () => gitMocks);

const storeMocks = vi.hoisted(() => ({
  readPageInSubject: vi.fn((_subjectSlug: string, slug: string) => {
    if (slug === 'missing') return null;
    return {
      frontmatter: {
        title: slug === 'notes' ? 'Notes' : 'Page A',
        created: '2020-01-01T00:00:00.000Z',
        updated: '2020-01-01T00:00:00.000Z',
        tags: ['old'],
        sources: [],
      },
      body: slug === 'notes' ? 'See [[Page A]].' : 'old body',
    };
  }),
}));
vi.mock('../wiki-store', () => storeMocks);

const repoMocks = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'page-a' }]),
  getBacklinks: vi.fn(() => [] as Array<{ subjectId: string; slug: string }>),
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);

import {
  applyPatchEdits,
  applyPlannedPageOperation,
  planPageCreate,
  planPageDelete,
  planPagePatch,
  planPageUpdate,
} from '../page-operation-plan';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '', augmentationLevel: 'standard',
  createdAt: '', updatedAt: '',
} as const;
const effectiveAt = '2026-07-11T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  gitMocks.getVaultHead.mockResolvedValue('head-1');
  txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
  repoMocks.getAllPages.mockReturnValue([{ slug: 'page-a' }]);
  repoMocks.getBacklinks.mockReturnValue([]);
});

describe('页面操作 planner', () => {
  it('create 只生成稳定 changeset/diff，不 apply', async () => {
    const plan = await planPageCreate('job-1', subject, {
      title: 'Page A', body: 'new body', effectiveAt,
    });

    expect(plan).toMatchObject({
      operation: 'create', preHead: 'head-1',
      affectedPages: [{ slug: 'page-a-2', action: 'create' }],
      resultHint: { createdSlug: 'page-a-2' },
    });
    expect(plan.diff).toContain('--- /dev/null');
    expect(plan.diff).toContain('+++ b/wiki/general/page-a-2.md');
    expect(plan.diff).toContain('2026-07-11T00:00:00.000Z');
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('update 改标题时把 backlink 重写纳入同一规划', async () => {
    repoMocks.getBacklinks.mockReturnValue([{ subjectId: 's1', slug: 'notes' }]);
    const plan = await planPageUpdate('job-2', subject, {
      slug: 'page-a', title: 'Page Alpha', body: 'new body', effectiveAt,
    });

    expect(plan.affectedPages).toEqual([
      { slug: 'page-a', action: 'update' },
      { slug: 'notes', action: 'update' },
    ]);
    expect(plan.resultHint.referencesUpdated).toBe(1);
    expect(plan.diff).toContain('[[Page Alpha]]');
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('patch 与 delete 生成预览，apply 时才传 expectedPreHead', async () => {
    const patch = await planPagePatch('job-3', subject, {
      slug: 'page-a', edits: [{ oldString: 'old body', newString: 'new body' }], effectiveAt,
    });
    expect(patch.operation).toBe('patch');
    expect(patch.resultHint).toMatchObject({ updatedSlug: 'page-a', appliedEdits: 1 });
    expect(patch.diff).toContain('-old body');
    expect(patch.diff).toContain('+new body');

    const deletion = await planPageDelete('job-4', subject, { slug: 'page-a', effectiveAt });
    expect(deletion.diff).toContain('+++ /dev/null');
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();

    await applyPlannedPageOperation(deletion);
    expect(txMocks.applyChangeset).toHaveBeenCalledWith(
      deletion.changeset,
      undefined,
      { expectedPreHead: 'head-1' },
    );
  });

  it('patch 仍要求 oldString 唯一命中', () => {
    expect(() => applyPatchEdits('x x', [{ oldString: 'x', newString: 'y' }]))
      .toThrow(/matches 2 locations/);
  });
});
