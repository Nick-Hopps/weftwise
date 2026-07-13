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

const gitMocks = vi.hoisted(() => ({
  head: 'head-1',
  getVaultHead: vi.fn(async () => 'head-1'),
}));
vi.mock('../../git/git-service', () => ({ getVaultHead: gitMocks.getVaultHead }));

const storeMocks = vi.hoisted(() => {
  const sourceDoc = (body = 'Read anchor here.') => ({
    frontmatter: {
      title: 'Source', created: '2020-01-01', updated: '2020-01-02', tags: [], sources: [],
    },
    body,
    links: [],
  });
  return {
    sourceDoc,
    readPageInSubject: vi.fn((_subjectSlug: string, slug: string) => (
      slug === 'source' ? sourceDoc() : null
    )),
    scanWikiPages: vi.fn(() => []),
  };
});
vi.mock('../wiki-store', () => storeMocks);

const repoMocks = vi.hoisted(() => ({
  getAllPages: vi.fn(() => []),
  getBacklinks: vi.fn(() => []),
  getPageBySlug: vi.fn((subjectId: string, slug: string) => (
    slug === 'missing' ? null : { subjectId, slug, title: slug }
  )),
  getTitleToSlugMap: vi.fn(() => new Map()),
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);

const subjectMocks = vi.hoisted(() => ({
  getBySlug: vi.fn((slug: string) => (
    slug === 'missing-subject'
      ? null
      : { id: `subject-${slug}`, slug, name: slug, description: '', augmentationLevel: 'standard' }
  )),
}));
vi.mock('../../db/repos/subjects-repo', () => subjectMocks);
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { planPageLinkEnsure } from '../page-operation-plan';
import { executePageLinkEnsure } from '../page-ops';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '', augmentationLevel: 'standard',
  createdAt: '', updatedAt: '',
} as const;
const effectiveAt = '2026-07-13T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  gitMocks.head = 'head-1';
  gitMocks.getVaultHead.mockImplementation(async () => gitMocks.head);
  storeMocks.readPageInSubject.mockImplementation((_subjectSlug, slug) => (
    slug === 'source' ? storeMocks.sourceDoc() : null
  ));
  repoMocks.getPageBySlug.mockImplementation((subjectId, slug) => (
    slug === 'missing' ? null : { subjectId, slug, title: slug }
  ));
  subjectMocks.getBySlug.mockImplementation((slug) => (
    slug === 'missing-subject'
      ? null
      : { id: `subject-${slug}`, slug, name: slug, description: '', augmentationLevel: 'standard' }
  ));
  txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
});

describe('planPageLinkEnsure', () => {
  it.each(['../other/page', '../other/index'])('在任何读取前拒绝越界 sourceSlug：%s', async (sourceSlug) => {
    await expect(planPageLinkEnsure('job-traversal', subject, {
      sourceSlug, targetSlug: 'target', oldString: 'anchor', mode: 'link', effectiveAt,
    })).rejects.toThrow(/canonical page slug/i);
    expect(gitMocks.getVaultHead).not.toHaveBeenCalled();
    expect(storeMocks.readPageInSubject).not.toHaveBeenCalled();
    expect(subjectMocks.getBySlug).not.toHaveBeenCalled();
    expect(repoMocks.getPageBySlug).not.toHaveBeenCalled();
  });

  it('保留合法嵌套 sourceSlug', async () => {
    storeMocks.readPageInSubject.mockReturnValueOnce(storeMocks.sourceDoc());
    const plan = await planPageLinkEnsure('job-nested', subject, {
      sourceSlug: 'folder/source', targetSlug: 'target', oldString: 'anchor',
      mode: 'link', effectiveAt,
    });
    expect(storeMocks.readPageInSubject).toHaveBeenCalledWith('general', 'folder/source');
    expect(plan.affectedPages).toEqual([{ slug: 'folder/source', action: 'update' }]);
  });

  it('同主题 link 只写 source，并产出 link-ensure 结果', async () => {
    const plan = await planPageLinkEnsure('job-link', subject, {
      sourceSlug: 'source', targetSlug: 'target', oldString: 'anchor', mode: 'link', effectiveAt,
    });

    expect(plan.operation).toBe('link-ensure');
    expect(plan.resultHint).toEqual({
      updatedSlug: 'source', mode: 'link', targetSubjectSlug: 'general', targetSlug: 'target',
    });
    expect(plan.affectedPages).toEqual([{ slug: 'source', action: 'update' }]);
    expect(plan.changeset.entries).toHaveLength(1);
    expect(plan.changeset.entries[0]?.content).toContain('Read [[target|anchor]] here.');
    expect(repoMocks.getPageBySlug).toHaveBeenCalledWith('s1', 'target');
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('跨主题 retarget 校验 target 并保留显示文本', async () => {
    storeMocks.readPageInSubject.mockReturnValueOnce(
      storeMocks.sourceDoc('See [[old-page|Shown]] now.'),
    );
    const plan = await planPageLinkEnsure('job-retarget', subject, {
      sourceSlug: 'source', targetSubjectSlug: 'other', targetSlug: 'New Page',
      oldString: '[[old-page|Shown]]', mode: 'retarget', effectiveAt,
    });
    expect(plan.resultHint).toMatchObject({
      mode: 'retarget', targetSubjectSlug: 'other', targetSlug: 'new-page',
    });
    expect(plan.changeset.entries[0]?.content).toContain('[[other:new-page|Shown]]');
    expect(subjectMocks.getBySlug).toHaveBeenCalledWith('other');
    expect(repoMocks.getPageBySlug).toHaveBeenCalledWith('subject-other', 'new-page');
  });

  it('link/retarget 拒绝不存在 target Subject/page', async () => {
    await expect(planPageLinkEnsure('job-missing-page', subject, {
      sourceSlug: 'source', targetSlug: 'missing', oldString: 'anchor', mode: 'link', effectiveAt,
    })).rejects.toThrow(/target page.*not found/i);
    await expect(planPageLinkEnsure('job-missing-subject', subject, {
      sourceSlug: 'source', targetSubjectSlug: 'missing-subject', targetSlug: 'target',
      oldString: 'anchor', mode: 'link', effectiveAt,
    })).rejects.toThrow(/target subject.*not found/i);

    storeMocks.readPageInSubject.mockReturnValueOnce(storeMocks.sourceDoc('[[old|Shown]]'));
    await expect(planPageLinkEnsure('job-retarget-missing', subject, {
      sourceSlug: 'source', targetSlug: 'missing', oldString: '[[old|Shown]]',
      mode: 'retarget', effectiveAt,
    })).rejects.toThrow(/target page.*not found/i);
  });

  it('unlink broken link 不查询 target 存在性', async () => {
    storeMocks.readPageInSubject.mockReturnValueOnce(
      storeMocks.sourceDoc('Before [[gone-subject:missing|Missing]] after.'),
    );
    const plan = await planPageLinkEnsure('job-unlink', subject, {
      sourceSlug: 'source', targetSubjectSlug: 'gone-subject', targetSlug: 'missing',
      oldString: 'Before [[gone-subject:missing|Missing]] after.', mode: 'unlink', effectiveAt,
    });
    expect(plan.changeset.entries[0]?.content).toContain('Before Missing after.');
    expect(subjectMocks.getBySlug).not.toHaveBeenCalled();
    expect(repoMocks.getPageBySlug).not.toHaveBeenCalled();
  });

  it('读取期间 HEAD 变化仍保留初始 preHead，source 只读一次且 diff 不二读', async () => {
    gitMocks.head = 'head-initial';
    let sourceReads = 0;
    storeMocks.readPageInSubject.mockImplementation((_subjectSlug, slug) => {
      if (slug !== 'source') return null;
      sourceReads += 1;
      const doc = sourceReads === 1
        ? storeMocks.sourceDoc()
        : storeMocks.sourceDoc('CONCURRENT BODY');
      gitMocks.head = 'head-after-read';
      return doc;
    });

    const plan = await planPageLinkEnsure('job-concurrent', subject, {
      sourceSlug: 'source', targetSlug: 'target', oldString: 'anchor', mode: 'link', effectiveAt,
    });
    expect(plan.preHead).toBe('head-initial');
    expect(sourceReads).toBe(1);
    expect(plan.diff).not.toContain('CONCURRENT BODY');
  });
});

describe('executePageLinkEnsure', () => {
  it('复用 planner 后 apply，不负责 enqueue', async () => {
    const result = await executePageLinkEnsure('job-direct', subject, {
      sourceSlug: 'source', targetSlug: 'target', oldString: 'anchor', mode: 'link',
    });
    expect(result).toEqual({
      updatedSlug: 'source', mode: 'link', targetSubjectSlug: 'general', targetSlug: 'target',
    });
    expect(txMocks.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cs-job-direct' }), undefined, { expectedPreHead: 'head-1' },
    );
  });
});
