import { beforeEach, describe, expect, it, vi } from 'vitest';

const txMocks = vi.hoisted(() => ({
  captureSubjectMutationEpoch: vi.fn(() => 4),
  createChangeset: vi.fn((jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: `cs-${jobId}`, jobId, subjectId: subject.id, subjectSlug: subject.slug,
    mutationEpoch: 4, entries, preHead: '', postHead: null, status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(),
}));
vi.mock('../wiki-transaction', () => txMocks);
vi.mock('../../git/git-service', () => ({ getVaultHead: vi.fn(async () => 'head-move') }));
vi.mock('../../config/env', () => ({ vaultPath: (...parts: string[]) => `/missing/${parts.join('/')}` }));
vi.mock('../../db/repos/sources-repo', () => ({ getSourcesForPage: vi.fn(() => []) }));

const sourceDoc = {
  frontmatter: {
    title: 'Old Title', created: '2020-01-01', updated: '2020-01-02',
    tags: ['topic'], sources: ['source-1'], aliases: ['Legacy Title'],
  },
  body: 'Self [[old-page#part|self]].',
  links: [],
};
const noteDoc = {
  frontmatter: {
    title: 'Notes', created: '2020-01-01', updated: '2020-01-02', tags: [], sources: [],
  },
  body: 'See [[Old Title|old]].',
  links: [],
};
const storeMocks = vi.hoisted(() => ({
  readPageInSubject: vi.fn((_subject: string, slug: string) => {
    if (slug === 'old-page') return sourceDoc;
    if (slug === 'notes') return noteDoc;
    return null;
  }),
  scanWikiPages: vi.fn(() => []),
}));
vi.mock('../wiki-store', () => storeMocks);

const repoMocks = vi.hoisted(() => ({
  getPageBySlug: vi.fn((_subjectId: string, slug: string) => (
    slug === 'old-page'
      ? { subjectId: 's1', slug, title: 'Old Title', tags: ['topic'] }
      : null
  )),
  resolvePageAlias: vi.fn((): string | null => null),
  getTitleToSlugMap: vi.fn(() => new Map([
    ['Old Title', 'old-page'], ['old title', 'old-page'],
  ])),
  getBacklinks: vi.fn(() => [
    { subjectId: 's1', slug: 'old-page' },
    { subjectId: 's1', slug: 'notes' },
    { subjectId: 's2', slug: 'foreign-note' },
  ]),
  getAllPages: vi.fn(() => []),
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);

import { parseFrontmatter } from '../frontmatter';
import { planPageMove } from '../page-operation-plan';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '', augmentationLevel: 'standard',
  createdAt: '', updatedAt: '',
} as const;
const effectiveAt = '2026-07-14T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  repoMocks.getPageBySlug.mockImplementation((_subjectId, slug) => (
    slug === 'old-page'
      ? { subjectId: 's1', slug, title: 'Old Title', tags: ['topic'] }
      : null
  ));
  repoMocks.resolvePageAlias.mockReturnValue(null);
  repoMocks.getBacklinks.mockReturnValue([
    { subjectId: 's1', slug: 'old-page' },
    { subjectId: 's1', slug: 'notes' },
    { subjectId: 's2', slug: 'foreign-note' },
  ]);
  storeMocks.readPageInSubject.mockImplementation((_subject, slug) => {
    if (slug === 'old-page') return sourceDoc;
    if (slug === 'notes') return noteDoc;
    return null;
  });
});

describe('planPageMove', () => {
  it('规划目标创建、源删除和当前 Subject backlink 更新，并持久化旧 slug alias', async () => {
    const plan = await planPageMove('job-move', subject, {
      slug: 'old-page', newSlug: 'folder/new-page', effectiveAt,
    });

    expect(plan).toMatchObject({
      operation: 'move', preHead: 'head-move',
      resultHint: {
        movedFromSlug: 'old-page', movedToSlug: 'folder/new-page',
        referencesUpdated: 2, sourceLinksMigrated: 0,
      },
    });
    expect(plan.affectedPages).toEqual([
      { slug: 'folder/new-page', action: 'create' },
      { slug: 'old-page', action: 'delete' },
      { slug: 'notes', action: 'update' },
    ]);
    const entries = plan.changeset.entries;
    expect(entries[0]).toMatchObject({
      action: 'create', path: 'wiki/general/folder/new-page.md',
      movedFromPath: 'wiki/general/old-page.md',
    });
    const moved = parseFrontmatter(entries[0]!.content!);
    expect(moved.data.aliases).toEqual(['Legacy Title', 'old-page']);
    expect(moved.data.updated).toBe(effectiveAt);
    expect(moved.body).toContain('[[folder/new-page#part|self]]');
    expect(entries[2]!.content).toContain('[[folder/new-page|old]]');
    expect(plan.diff).not.toContain('.llm-wiki/sources');
  });

  it('拒绝 meta、已存在页面和其他页面占用的 alias 目标', async () => {
    await expect(planPageMove('job-meta', subject, {
      slug: 'index', newSlug: 'new-page', effectiveAt,
    })).rejects.toThrow(/protected/i);

    repoMocks.getPageBySlug.mockImplementation((_subjectId, slug) => ({
      subjectId: 's1', slug, title: slug, tags: [],
    }));
    await expect(planPageMove('job-conflict', subject, {
      slug: 'old-page', newSlug: 'taken', effectiveAt,
    })).rejects.toThrow(/already exists/i);

    repoMocks.getPageBySlug.mockImplementation((_subjectId, slug) => (
      slug === 'old-page' ? { subjectId: 's1', slug, title: 'Old', tags: [] } : null
    ));
    repoMocks.resolvePageAlias.mockReturnValue('other-page');
    await expect(planPageMove('job-alias', subject, {
      slug: 'old-page', newSlug: 'taken-alias', effectiveAt,
    })).rejects.toThrow(/alias of page "other-page"/i);
  });
});
