import { describe, it, expect, beforeEach, vi } from 'vitest';

const txMocks = vi.hoisted(() => ({
  createChangeset: vi.fn((jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: jobId, subjectId: subject.id, subjectSlug: subject.slug, entries,
    preHead: null, postHead: null, status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(async () => undefined),
}));
vi.mock('../wiki-transaction', () => txMocks);

const storeMocks = vi.hoisted(() => ({
  readPageInSubject: vi.fn(() => ({
    frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
    body: 'original body',
  })),
}));
vi.mock('../wiki-store', () => storeMocks);

// 中和 import-time 重依赖（page-ops 顶层为 merge/split 引入，update 不调用）
vi.mock('../../db/repos/pages-repo', () => ({ getBacklinks: vi.fn(() => []), getAllPages: vi.fn(() => []), getTitleToSlugMap: vi.fn(() => new Map()) }));
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { executePageUpdate } from '../page-ops';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('executePageUpdate', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
    storeMocks.readPageInSubject.mockReturnValue({
      frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
      body: 'original body',
    });
  });

  it('保留 title/created、替换正文、覆盖 tags 并 apply', async () => {
    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', body: 'new body', summary: 's', tags: ['linear-algebra'] });
    expect(out.updatedSlug).toBe('eigenvalue');
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries[0].action).toBe('update');
    expect(cs.entries[0].path).toBe('wiki/general/eigenvalue.md');
    expect(cs.entries[0].content).toContain('title: Eigenvalue'); // 保留原标题
    expect(cs.entries[0].content).toContain('new body');           // 换了正文
    expect(cs.entries[0].content).toContain('linear-algebra');      // 覆盖 tags
    expect(cs.entries[0].content).toContain('2020-01-01'); // 保留原 created 时间戳
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
    txMocks.validateChangeset.mockReturnValueOnce({ valid: true, errors: [], warnings: ['Unresolved wikilink: [[Ghost]]'] });
    await expect(executePageUpdate('j1', subject, { slug: 'eigenvalue', body: '[[Ghost]]' })).rejects.toThrow(/unresolved wikilink/i);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });
});
