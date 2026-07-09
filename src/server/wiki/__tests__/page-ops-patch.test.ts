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
  readPageInSubject: vi.fn((_subjectSlug: string, _slug: string) => ({
    frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
    body: '# A\n\nfoo bar baz\n\n## B\n\nqux quux\n',
  })),
}));
vi.mock('../wiki-store', () => storeMocks);

const repoMocks = vi.hoisted(() => ({
  getBacklinks: vi.fn(() => [] as Array<{ subjectId: string; slug: string }>),
  getAllPages: vi.fn(() => [] as Array<{ slug: string }>),
  getTitleToSlugMap: vi.fn(() => new Map()),
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);

// 中和 import-time 重依赖（page-ops 顶层为 merge/split 引入，patch/update 不调用）
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { applyPatchEdits, executePagePatch } from '../page-ops';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('applyPatchEdits', () => {
  const body = '# A\n\nfoo bar baz\n\n## B\n\nqux quux\n';

  it('单处替换', () => {
    expect(applyPatchEdits(body, [{ oldString: 'foo bar baz', newString: 'foo BAR baz' }]))
      .toBe('# A\n\nfoo BAR baz\n\n## B\n\nqux quux\n');
  });

  it('多组顺序替换，后一组可匹配前一组产物', () => {
    const out = applyPatchEdits(body, [
      { oldString: 'qux quux', newString: 'qux NEW quux' },
      { oldString: 'NEW quux', newString: 'NEW2 quux' },
    ]);
    expect(out).toContain('qux NEW2 quux');
  });

  it('0 匹配抛错并带序号', () => {
    expect(() => applyPatchEdits(body, [{ oldString: 'nope', newString: 'x' }]))
      .toThrow(/edit #1: old_string not found/);
  });

  it('多处匹配抛错并带出现次数', () => {
    expect(() => applyPatchEdits(body, [{ oldString: 'qu', newString: 'x' }]))
      .toThrow(/edit #1: old_string matches \d+ locations/);
  });

  it('空 oldString 拒绝', () => {
    expect(() => applyPatchEdits(body, [{ oldString: '', newString: 'x' }]))
      .toThrow(/edit #1: old_string must not be empty/);
  });

  it('old === new 拒绝', () => {
    expect(() => applyPatchEdits(body, [{ oldString: 'foo', newString: 'foo' }]))
      .toThrow(/edit #1: old_string and new_string are identical/);
  });

  it('空 edits 拒绝', () => {
    expect(() => applyPatchEdits(body, [])).toThrow(/at least one edit/);
  });
});

describe('executePagePatch', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
    repoMocks.getBacklinks.mockReset();
    repoMocks.getBacklinks.mockReturnValue([]);
    storeMocks.readPageInSubject.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeMocks.readPageInSubject.mockImplementation((): any => ({
      frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
      body: '# A\n\nfoo bar baz\n\n## B\n\nqux quux\n',
    }));
  });

  it('patch 成功 → 读回页面正文含替换产物，frontmatter title 未变', async () => {
    const out = await executePagePatch('j1', subject, {
      slug: 'eigenvalue',
      edits: [{ oldString: 'foo bar baz', newString: 'foo BAR baz' }],
    });
    expect(out.updatedSlug).toBe('eigenvalue');
    expect(out.appliedEdits).toBe(1);
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0].content).toContain('foo BAR baz');
    expect(cs.entries[0].content).toContain('title: Eigenvalue');
  });

  it('patch 引入坏链 → 抛 unresolved wikilink，页面正文与 patch 前一致（原子性）', async () => {
    txMocks.validateChangeset.mockReturnValueOnce({
      valid: true,
      errors: [],
      warnings: ['[wiki/general/eigenvalue.md] Unresolved wikilink: [[Ghost Page]]'],
    });
    await expect(executePagePatch('j1', subject, {
      slug: 'eigenvalue',
      edits: [{ oldString: 'foo bar baz', newString: 'foo [[Ghost Page]] baz' }],
    })).rejects.toThrow(/unresolved wikilink/i);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('页不存在 → 抛 page "x" not found', async () => {
    storeMocks.readPageInSubject.mockReturnValueOnce(null as never);
    await expect(executePagePatch('j1', subject, {
      slug: 'x',
      edits: [{ oldString: 'a', newString: 'b' }],
    })).rejects.toThrow(/page "x" not found/);
  });
});
