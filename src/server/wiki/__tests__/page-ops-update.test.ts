import { describe, it, expect, beforeEach, vi } from 'vitest';

const txMocks = vi.hoisted(() => ({
  captureSubjectMutationEpoch: vi.fn(() => 0),
  createChangeset: vi.fn((jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: jobId, subjectId: subject.id, subjectSlug: subject.slug, entries,
    preHead: null, postHead: null, status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(async (changeset: Record<string, unknown>) => ({ ...changeset, status: 'applied' })),
}));
vi.mock('../wiki-transaction', () => txMocks);

vi.mock('../../git/git-service', () => ({ getVaultHead: vi.fn(async () => 'head-1') }));

const storeMocks = vi.hoisted(() => ({
  readPageInSubject: vi.fn((_subjectSlug: string, _slug: string) => ({
    frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
    body: 'original body',
  })),
}));
vi.mock('../wiki-store', () => storeMocks);

const repoMocks = vi.hoisted(() => ({
  getBacklinks: vi.fn(() => [] as Array<{ subjectId: string; slug: string }>),
  getAllPages: vi.fn(() => [] as Array<{ slug: string }>),
  getTitleToSlugMap: vi.fn(() => new Map()),
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);

// 中和 import-time 重依赖（page-ops 顶层为 merge/split 引入，update 不调用）
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { executePageUpdate } from '../page-ops';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('executePageUpdate', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
    repoMocks.getBacklinks.mockReset();
    repoMocks.getBacklinks.mockReturnValue([]);
    storeMocks.readPageInSubject.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeMocks.readPageInSubject.mockImplementation((): any => ({
      frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
      body: 'original body',
    }));
  });

  it('保留 title/created、替换正文、覆盖 tags 并 apply（不传 title = 行为不变）', async () => {
    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', body: 'new body', summary: 's', tags: ['linear-algebra'] });
    expect(out.updatedSlug).toBe('eigenvalue');
    expect(out.referencesUpdated).toBe(0);
    expect(repoMocks.getBacklinks).not.toHaveBeenCalled(); // 标题未变，不查 backlinks
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0].action).toBe('update');
    expect(cs.entries[0].path).toBe('wiki/general/eigenvalue.md');
    expect(cs.entries[0].content).toContain('title: Eigenvalue'); // 保留原标题
    expect(cs.entries[0].content).toContain('new body');           // 换了正文
    expect(cs.entries[0].content).toContain('linear-algebra');      // 覆盖 tags
    expect(cs.entries[0].content).toContain('2020-01-01'); // 保留原 created 时间戳
  });

  it('传同名 title（未变化）→ referencesUpdated=0，不查 backlinks', async () => {
    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', title: 'Eigenvalue', body: 'new body' });
    expect(out.referencesUpdated).toBe(0);
    expect(repoMocks.getBacklinks).not.toHaveBeenCalled();
  });

  it('改标题：联动重写本 subject 内引用旧标题的其他页，计入 referencesUpdated', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeMocks.readPageInSubject.mockImplementation((_subjectSlug: string, slug: string): any => {
      if (slug === 'eigenvalue') {
        return {
          frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
          body: 'original body',
        };
      }
      if (slug === 'linear-algebra-notes') {
        return {
          frontmatter: { title: 'Linear Algebra Notes', created: '2021-01-01T00:00:00.000Z', updated: '2021-01-01T00:00:00.000Z', tags: [], sources: [] },
          body: 'See [[Eigenvalue]] for details.',
        };
      }
      return null;
    });
    repoMocks.getBacklinks.mockReturnValue([{ subjectId: 's1', slug: 'linear-algebra-notes' }]);

    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', title: 'Eigen Value', body: 'new body' });

    expect(out.updatedSlug).toBe('eigenvalue');
    expect(out.referencesUpdated).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries).toHaveLength(2);
    const selfEntry = cs.entries.find((e) => e.path === 'wiki/general/eigenvalue.md');
    expect(selfEntry?.content).toContain('title: Eigen Value');
    const backlinkEntry = cs.entries.find((e) => e.path === 'wiki/general/linear-algebra-notes.md');
    expect(backlinkEntry?.content).toContain('[[Eigen Value]]');
    expect(backlinkEntry?.content).not.toContain('[[Eigenvalue]]');
  });

  it('改标题：自引用（backlinks 含自身 slug）不被重复处理', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeMocks.readPageInSubject.mockImplementation((_subjectSlug: string, slug: string): any => {
      if (slug === 'eigenvalue') {
        return {
          frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
          body: 'See also [[Eigenvalue]] intro section.',
        };
      }
      return null;
    });
    repoMocks.getBacklinks.mockReturnValue([{ subjectId: 's1', slug: 'eigenvalue' }]); // 自引用

    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', title: 'Eigen Value', body: 'new body' });
    expect(out.referencesUpdated).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string }> };
    expect(cs.entries).toHaveLength(1); // 只有自身这一条 update，没有额外的 backlink 条目
  });

  it('页面不存在 → 抛错', async () => {
    storeMocks.readPageInSubject.mockReturnValueOnce(null as never);
    await expect(executePageUpdate('j1', subject, { slug: 'ghost', body: 'x' })).rejects.toThrow(/not found/);
  });

  it('validateChangeset 失败（跨主题坏链）→ 抛错不 apply', async () => {
    txMocks.validateChangeset.mockReturnValueOnce({ valid: false, errors: ['broken'], warnings: [] });
    await expect(executePageUpdate('j1', subject, { slug: 'eigenvalue', body: '[[other:Ghost]]' })).rejects.toThrow(/invalid/);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('留下同主题 unresolved-wikilink → 抛错不 apply', async () => {
    txMocks.validateChangeset.mockReturnValueOnce({ valid: true, errors: [], warnings: ['[wiki/general/eigenvalue.md] Unresolved wikilink: [[Ghost]]'] });
    await expect(executePageUpdate('j1', subject, { slug: 'eigenvalue', body: '[[Ghost]]' })).rejects.toThrow(/unresolved wikilink/i);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('改标题：backlink entry 的 unresolved warning 不应该拒绝更新', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeMocks.readPageInSubject.mockImplementation((_subjectSlug: string, slug: string): any => {
      if (slug === 'eigenvalue') {
        return {
          frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
          body: 'original body',
        };
      }
      if (slug === 'linear-algebra-notes') {
        return {
          frontmatter: { title: 'Linear Algebra Notes', created: '2021-01-01T00:00:00.000Z', updated: '2021-01-01T00:00:00.000Z', tags: [], sources: [] },
          body: 'See [[Eigenvalue]] for details.',
        };
      }
      return null;
    });
    repoMocks.getBacklinks.mockReturnValue([{ subjectId: 's1', slug: 'linear-algebra-notes' }]);
    txMocks.validateChangeset.mockReturnValueOnce({
      valid: true,
      errors: [],
      warnings: ['[wiki/general/linear-algebra-notes.md] Unresolved wikilink: [[Eigen Value]]'],
    });

    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', title: 'Eigen Value', body: 'new body' });

    expect(out.updatedSlug).toBe('eigenvalue');
    expect(out.referencesUpdated).toBe(1);
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
  });

  it('改标题：self entry 的 unresolved warning 仍然要拒绝', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeMocks.readPageInSubject.mockImplementation((_subjectSlug: string, slug: string): any => {
      if (slug === 'eigenvalue') {
        return {
          frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
          body: 'original body',
        };
      }
      return null;
    });
    repoMocks.getBacklinks.mockReturnValue([]);
    txMocks.validateChangeset.mockReturnValueOnce({
      valid: true,
      errors: [],
      warnings: ['[wiki/general/eigenvalue.md] Unresolved wikilink: [[Ghost]]'],
    });

    await expect(executePageUpdate('j1', subject, { slug: 'eigenvalue', title: 'Eigen Value', body: '[[Ghost]]' })).rejects.toThrow(/unresolved wikilink/i);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });
});
