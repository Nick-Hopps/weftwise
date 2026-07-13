import { describe, it, expect, beforeEach, vi } from 'vitest';

// 捕获 changeset 条目；validate 默认通过；apply 空跑
const txMocks = vi.hoisted(() => ({
  createChangeset: vi.fn((jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: jobId, subjectId: subject.id, subjectSlug: subject.slug, entries,
    preHead: null, postHead: null, status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[] })),
  applyChangeset: vi.fn(async (changeset: Record<string, unknown>) => ({ ...changeset, status: 'applied' })),
}));
vi.mock('../wiki-transaction', () => txMocks);

vi.mock('../../git/git-service', () => ({ getVaultHead: vi.fn(async () => 'head-1') }));

const repoMocks = vi.hoisted(() => ({
  getBacklinks: vi.fn(() => [] as Array<{ slug: string }>),
  getAllPages: vi.fn(() => [] as Array<{ slug: string }>),
  getTitleToSlugMap: vi.fn(() => new Map()), // merge/split 用，本测试不触发
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);

vi.mock('../wiki-store', () => ({
  readPageInSubject: vi.fn(() => ({
    frontmatter: {
      title: 'Eigen', created: '2020-01-01', updated: '2020-01-02',
      tags: ['math'], sources: [],
    },
    body: 'captured body',
    links: [],
  })),
  scanWikiPages: vi.fn(() => []),
}));

// 中和 import-time 重依赖（page-ops 顶层为 merge/split 引入，create/delete 不调用）
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { executePageDelete, executePageCreate } from '../page-ops';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('executePageDelete', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [] });
    repoMocks.getBacklinks.mockReset();
  });
  it('构造 delete 条目并 apply，返回 deletedSlug', async () => {
    repoMocks.getBacklinks.mockReturnValue([]);
    const out = await executePageDelete('j1', subject, 'eigen');
    expect(out.deletedSlug).toBe('eigen');
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: unknown }> };
    expect(cs.entries).toEqual([{ action: 'delete', path: 'wiki/general/eigen.md', content: null }]);
  });
  it('brokenBacklinks = 入站数（排除自引用）', async () => {
    repoMocks.getBacklinks.mockReturnValue([{ slug: 'a' }, { slug: 'b' }, { slug: 'eigen' }]);
    const out = await executePageDelete('j1', subject, 'eigen');
    expect(out.brokenBacklinks).toBe(2);
  });
  it('validateChangeset 失败 → 抛错，不 apply', async () => {
    repoMocks.getBacklinks.mockReturnValue([]);
    txMocks.validateChangeset.mockReturnValueOnce({ valid: false, errors: ['bad'] });
    await expect(executePageDelete('j1', subject, 'eigen')).rejects.toThrow(/invalid/);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });
});

describe('executePageCreate', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [] });
    repoMocks.getAllPages.mockReset();
  });
  it('title 派生唯一 slug（冲突加后缀）并 create', async () => {
    repoMocks.getAllPages.mockReturnValue([{ slug: 'foo' }]);
    const out = await executePageCreate('j1', subject, { title: 'Foo', body: 'hello world' });
    expect(out.createdSlug).toBe('foo-2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries[0].action).toBe('create');
    expect(cs.entries[0].path).toBe('wiki/general/foo-2.md');
    expect(cs.entries[0].content).toContain('title: Foo');
    expect(cs.entries[0].content).toContain('hello world');
  });
  it('validateChangeset 失败（如坏链）→ 抛错', async () => {
    repoMocks.getAllPages.mockReturnValue([]);
    txMocks.validateChangeset.mockReturnValueOnce({ valid: false, errors: ['broken link'] });
    await expect(executePageCreate('j1', subject, { title: 'X', body: '[[Ghost]]' })).rejects.toThrow(/invalid/);
  });
});
