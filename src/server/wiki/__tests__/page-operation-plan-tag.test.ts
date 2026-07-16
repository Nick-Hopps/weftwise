import { beforeEach, describe, expect, it, vi } from 'vitest';

const txMocks = vi.hoisted(() => ({
  captureSubjectMutationEpoch: vi.fn(() => 7),
  createChangeset: vi.fn((jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: `cs-${jobId}`, jobId, subjectId: subject.id, subjectSlug: subject.slug,
    mutationEpoch: 7, entries, preHead: '', postHead: null, status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(),
}));
vi.mock('../wiki-transaction', () => txMocks);
vi.mock('../../git/git-service', () => ({ getVaultHead: vi.fn(async () => 'head-tags') }));
vi.mock('../../config/env', () => ({ vaultPath: (...parts: string[]) => `/missing/${parts.join('/')}` }));
vi.mock('../../db/repos/sources-repo', () => ({ getSourcesForPage: vi.fn(() => []) }));
vi.mock('../../db/repos/pages-repo', () => ({
  getAllPages: vi.fn(() => []),
  getBacklinks: vi.fn(() => []),
  getTitleToSlugMap: vi.fn(() => new Map()),
}));

function rawPage(slug: string, tags: string[]): {
  subjectSlug: string; slug: string; relativePath: string; path: string; content: string;
} {
  return {
    subjectSlug: 'general',
    slug,
    relativePath: `wiki/general/${slug}.md`,
    path: `/vault/wiki/general/${slug}.md`,
    content: `---\ntitle: ${slug}\ncreated: 2026-01-01\nupdated: 2026-01-02\ntags:\n${tags.map((tag) => `  - ${tag}`).join('\n')}\nsources: []\n---\nBody ${slug}\n`,
  };
}

const storeMocks = vi.hoisted(() => ({
  scanWikiPages: vi.fn(),
  readPageInSubject: vi.fn(),
}));
vi.mock('../wiki-store', () => storeMocks);

import { parseFrontmatter } from '../frontmatter';
import { planTagBatch, rewritePageTags } from '../page-operation-plan';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '', augmentationLevel: 'standard',
  createdAt: '', updatedAt: '',
} as const;
const effectiveAt = '2026-07-16T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  storeMocks.scanWikiPages.mockReturnValue([
    rawPage('one', ['source', 'topic']),
    rawPage('two', ['target', 'source']),
    rawPage('three', ['target']),
    rawPage('index', ['meta', 'source']),
  ]);
  txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
});

describe('rewritePageTags', () => {
  it('替换保持位置，目标已存在时去掉 source，删除时只移除 source', () => {
    expect(rewritePageTags(['a', 'source', 'b'], 'source', 'target'))
      .toEqual(['a', 'target', 'b']);
    expect(rewritePageTags(['target', 'source', 'b'], 'source', 'target'))
      .toEqual(['target', 'b']);
    expect(rewritePageTags(['a', 'source', 'b'], 'source'))
      .toEqual(['a', 'b']);
  });
});

describe('planTagBatch', () => {
  it('merge 把全部内容页写入一个 changeset，正文不变并跳过 meta 页', async () => {
    const plan = await planTagBatch('job-tags', subject, {
      action: 'merge', sourceTag: 'source', targetTag: 'target', effectiveAt,
    });

    expect(plan).toMatchObject({
      operation: 'tag-batch', preHead: 'head-tags',
      summary: '合并标签 source → target（2 个页面）',
      resultHint: {
        action: 'merge', sourceTag: 'source', targetTag: 'target', updatedPages: ['one', 'two'],
      },
    });
    expect(plan.affectedPages).toEqual([
      { slug: 'one', action: 'update' },
      { slug: 'two', action: 'update' },
    ]);
    expect(plan.changeset.entries).toHaveLength(2);
    expect(txMocks.createChangeset).toHaveBeenCalledOnce();
    const one = parseFrontmatter(plan.changeset.entries[0]!.content!);
    const two = parseFrontmatter(plan.changeset.entries[1]!.content!);
    expect(one.data.tags).toEqual(['target', 'topic']);
    expect(two.data.tags).toEqual(['target']);
    expect(one.data.updated).toBe(effectiveAt);
    expect(one.body).toBe('Body one\n');
    expect(plan.diff).toContain('-  - source');
    expect(plan.diff).not.toContain('wiki/general/index.md');
  });

  it('rename 要求新目标不存在，merge 要求既有目标存在', async () => {
    await expect(planTagBatch('rename-conflict', subject, {
      action: 'rename', sourceTag: 'source', targetTag: 'target', effectiveAt,
    })).rejects.toThrow(/use merge/i);
    await expect(planTagBatch('merge-missing', subject, {
      action: 'merge', sourceTag: 'source', targetTag: 'missing', effectiveAt,
    })).rejects.toThrow(/use rename/i);

    const renamed = await planTagBatch('rename-ok', subject, {
      action: 'rename', sourceTag: 'source', targetTag: 'fresh', effectiveAt,
    });
    expect(renamed.resultHint.updatedPages).toEqual(['one', 'two']);
  });

  it('拒绝 meta、同名目标和不存在的 source', async () => {
    await expect(planTagBatch('meta', subject, {
      action: 'delete', sourceTag: 'meta', effectiveAt,
    })).rejects.toThrow(/protected/i);
    await expect(planTagBatch('same', subject, {
      action: 'rename', sourceTag: 'source', targetTag: 'source', effectiveAt,
    })).rejects.toThrow(/differ/i);
    await expect(planTagBatch('missing', subject, {
      action: 'delete', sourceTag: 'missing', effectiveAt,
    })).rejects.toThrow(/not used/i);
  });
});
