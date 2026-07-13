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

const ORIGINAL_BODY = 'line 1\r\n\r\nline 2\n';
const storeMocks = vi.hoisted(() => {
  const readPage = (_subjectSlug: string, slug: string) => {
    if (slug === 'missing') return null;
    if (slug === 'notes') {
      return {
        frontmatter: {
          title: 'Notes', created: '2020-01-01', updated: '2020-01-02',
          tags: [], sources: [],
        },
        body: 'See [[Page A]].',
        links: [],
      };
    }
    return {
      frontmatter: {
        title: 'Page A', summary: 'Old summary', aliases: ['Page One'],
        created: '2020-01-01', updated: '2020-01-02', tags: ['old'], sources: ['source-1'],
      },
      body: ORIGINAL_BODY,
      links: [],
    };
  };
  return {
    readPage,
    readPageInSubject: vi.fn(readPage),
    scanWikiPages: vi.fn(() => [
      {
        slug: 'page-a',
        relativePath: 'wiki/general/page-a.md',
        content: '---\ntitle: Page A\ncreated: 2020-01-01\nupdated: 2020-01-02\ntags: []\nsources: []\naliases:\n  - Page One\n---\nself',
      },
      {
        slug: 'other-page',
        relativePath: 'wiki/general/other-page.md',
        content: '---\ntitle: Other Title\ncreated: 2020-01-01\nupdated: 2020-01-02\ntags: []\nsources: []\naliases:\n  - Legacy Name\n---\nother',
      },
    ]),
  };
});
vi.mock('../wiki-store', () => storeMocks);

const repoMocks = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'page-a', title: 'Page A' }]),
  getBacklinks: vi.fn(() => [] as Array<{ subjectId: string; slug: string }>),
  getTitleToSlugMap: vi.fn(() => new Map()),
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { parseFrontmatter } from '../frontmatter';
import { planPageMetadataPatch } from '../page-operation-plan';
import { executePageMetadataPatch } from '../page-ops';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '', augmentationLevel: 'standard',
  createdAt: '', updatedAt: '',
} as const;
const effectiveAt = '2026-07-13T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  gitMocks.head = 'head-1';
  gitMocks.getVaultHead.mockImplementation(async () => gitMocks.head);
  storeMocks.readPageInSubject.mockImplementation(storeMocks.readPage);
  txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
  repoMocks.getBacklinks.mockReturnValue([]);
});

describe('planPageMetadataPatch', () => {
  it('path traversal slug 在读取 HEAD/页面或构造 changeset 前拒绝', async () => {
    await expect(planPageMetadataPatch('job-traversal', subject, {
      slug: '../other/page', summary: '越界', effectiveAt,
    })).rejects.toThrow(/canonical page slug/i);

    expect(gitMocks.getVaultHead).not.toHaveBeenCalled();
    expect(storeMocks.readPageInSubject).not.toHaveBeenCalled();
    expect(txMocks.createChangeset).not.toHaveBeenCalled();
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('正文逐字保留，title relink 与 metadata 更新进入同一 changeset', async () => {
    repoMocks.getBacklinks.mockReturnValue([{ subjectId: 's1', slug: 'notes' }]);
    const reads = new Map<string, number>();
    storeMocks.readPageInSubject.mockImplementation((subjectSlug, slug) => {
      const count = (reads.get(slug) ?? 0) + 1;
      reads.set(slug, count);
      const doc = storeMocks.readPage(subjectSlug, slug);
      return count === 1 || !doc
        ? doc
        : { ...doc, body: `CONCURRENT ${slug} BODY` };
    });

    const plan = await planPageMetadataPatch('job-metadata', subject, {
      slug: 'page-a',
      title: ' Page Alpha ',
      summary: ' New summary ',
      aliases: ['New Alias'],
      effectiveAt,
    });

    expect(plan.operation).toBe('metadata-patch');
    expect(plan.resultHint).toEqual({
      updatedSlug: 'page-a',
      referencesUpdated: 1,
      changedFields: ['title', 'summary', 'aliases'],
    });
    expect(plan.affectedPages).toEqual([
      { slug: 'page-a', action: 'update' },
      { slug: 'notes', action: 'update' },
    ]);
    const self = plan.changeset.entries[0]!;
    const parsed = parseFrontmatter(self.content!);
    expect(parsed.body).toBe(ORIGINAL_BODY);
    expect(parsed.data).toMatchObject({
      title: 'Page Alpha', summary: 'New summary', aliases: ['New Alias'],
      created: '2020-01-01', updated: effectiveAt, sources: ['source-1'],
    });
    expect(plan.changeset.entries[1]?.content).toContain('[[Page Alpha]]');
    expect(reads).toEqual(new Map([['page-a', 1], ['notes', 1]]));
    expect(plan.diff).not.toContain('CONCURRENT');
    expect(txMocks.createChangeset).toHaveBeenCalledOnce();
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it.each([
    ['title', { title: 'Page Alpha' }],
    ['summary', { summary: 'New summary' }],
    ['tags', { tags: ['new-tag'] }],
  ])('%s-only 更新不扫描全 Subject aliases', async (_field, patch) => {
    await planPageMetadataPatch('job-simple', subject, {
      slug: 'page-a', ...patch, effectiveAt,
    });
    expect(storeMocks.scanWikiPages).not.toHaveBeenCalled();
  });

  it('aliases=[] 清空不扫描，非空 aliases 才扫描', async () => {
    const cleared = await planPageMetadataPatch('job-clear-aliases', subject, {
      slug: 'page-a', aliases: [], effectiveAt,
    });
    expect(cleared.resultHint.changedFields).toEqual(['aliases']);
    expect(storeMocks.scanWikiPages).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await planPageMetadataPatch('job-aliases', subject, {
      slug: 'page-a', aliases: ['Fresh Alias'], effectiveAt,
    });
    expect(storeMocks.scanWikiPages).toHaveBeenCalledOnce();
  });

  it('扫描 vault frontmatter，拒绝 alias 与其他页身份冲突', async () => {
    await expect(planPageMetadataPatch('job-conflict', subject, {
      slug: 'page-a', aliases: ['legacy_name'], effectiveAt,
    })).rejects.toThrow(/alias conflict.*other-page/i);
    expect(storeMocks.scanWikiPages).toHaveBeenCalledWith('general');
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('扫描页 frontmatter 解析失败时包装 slug/relativePath 并保留 cause', async () => {
    storeMocks.scanWikiPages.mockReturnValueOnce([{
      slug: 'broken-page',
      relativePath: 'wiki/general/broken-page.md',
      content: '---\ntitle: [\n---\nbroken',
    }]);

    let caught: unknown;
    try {
      await planPageMetadataPatch('job-bad-frontmatter', subject, {
        slug: 'page-a', aliases: ['Fresh Alias'], effectiveAt,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/broken-page.*wiki\/general\/broken-page\.md/i);
    expect((caught as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('缺页与无实际变化均不生成 changeset', async () => {
    await expect(planPageMetadataPatch('job-missing', subject, {
      slug: 'missing', title: 'Ghost', effectiveAt,
    })).rejects.toThrow(/not found/i);
    await expect(planPageMetadataPatch('job-empty', subject, {
      slug: 'page-a', title: 'Page A', effectiveAt,
    })).rejects.toThrow(/no actual metadata changes/i);
    expect(txMocks.createChangeset).not.toHaveBeenCalled();
  });

  it('读取期间 HEAD 变化时仍保留读取前的初始 preHead', async () => {
    gitMocks.head = 'head-initial';
    storeMocks.readPageInSubject.mockImplementation((...args) => {
      const doc = storeMocks.readPage(...args);
      gitMocks.head = 'head-after-read';
      return doc;
    });

    const plan = await planPageMetadataPatch('job-concurrent', subject, {
      slug: 'page-a', summary: 'Concurrent summary', effectiveAt,
    });
    expect(plan.preHead).toBe('head-initial');

    const { applyPlannedPageOperation } = await import('../page-operation-plan');
    await applyPlannedPageOperation(plan);
    expect(txMocks.applyChangeset).toHaveBeenCalledWith(
      plan.changeset,
      undefined,
      { expectedPreHead: 'head-initial' },
    );
  });
});

describe('executePageMetadataPatch', () => {
  it('复用同一 planner 后 apply，并只返回公共结果字段', async () => {
    const result = await executePageMetadataPatch('job-direct', subject, {
      slug: 'page-a', tags: ['new-tag'],
    });

    expect(result).toEqual({
      updatedSlug: 'page-a', referencesUpdated: 0, changedFields: ['tags'],
    });
    expect(storeMocks.scanWikiPages).not.toHaveBeenCalled();
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
    expect(txMocks.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cs-job-direct' }),
      undefined,
      { expectedPreHead: 'head-1' },
    );
  });
});
