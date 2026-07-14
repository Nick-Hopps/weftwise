import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetAllPages = vi.fn();
const mockGetPageBySlug = vi.fn();
const mockResolvePageAlias = vi.fn();
const mockHybrid = vi.fn();
const mockReadPage = vi.fn();
const mockCreatePendingActionPreview = vi.fn();
const mockCreatePendingHistoryRevertPreview = vi.fn();
const mockCreatePendingWorkflowActionPreview = vi.fn();
const mockReadWorkflowStatus = vi.fn();
const mockListHistory = vi.fn();
const mockReadHistoryDiff = vi.fn();
const mockListSubjects = vi.fn();
const mockGetSubjectBySlug = vi.fn();

vi.mock('@/server/db/repos/pages-repo', () => ({
  getAllPages: (...a: unknown[]) => mockGetAllPages(...a),
  getPageBySlug: (...a: unknown[]) => mockGetPageBySlug(...a),
  resolvePageAlias: (...a: unknown[]) => mockResolvePageAlias(...a),
  isMetaPage: (p: { tags?: string[] }) => (p.tags ?? []).includes('meta'),
}));
vi.mock('@/server/search/hybrid-retrieval', () => ({
  hybridRankSlugs: (...a: unknown[]) => mockHybrid(...a),
}));
vi.mock('@/server/db/repos/subjects-repo', () => ({
  listSubjects: (...a: unknown[]) => mockListSubjects(...a),
  getBySlug: (...a: unknown[]) => mockGetSubjectBySlug(...a),
}));
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: (...a: unknown[]) => mockReadPage(...a),
}));
vi.mock('../pending-action-service', () => ({
  createPendingActionPreview: (...a: unknown[]) => mockCreatePendingActionPreview(...a),
  createPendingHistoryRevertPreview: (...a: unknown[]) => mockCreatePendingHistoryRevertPreview(...a),
  createPendingWorkflowActionPreview: (...a: unknown[]) =>
    mockCreatePendingWorkflowActionPreview(...a),
}));
vi.mock('../history-tools', () => ({
  listHistory: (...a: unknown[]) => mockListHistory(...a),
  readHistoryDiff: (...a: unknown[]) => mockReadHistoryDiff(...a),
}));
vi.mock('../workflow-tools', () => ({
  readWorkflowStatus: (...a: unknown[]) => mockReadWorkflowStatus(...a),
}));

const mockWebSearch = vi.fn();
vi.mock('@/server/search/web-search', () => ({
  webSearch: (...a: unknown[]) => mockWebSearch(...a),
}));

import {
  buildQueryToolContext,
  createAccessedPages,
  accessedToContext,
} from '../query-tools';

const SUBJECT = {
  id: 's1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard' as const,
  createdAt: 't',
  updatedAt: 't',
};

const NOTES_SUBJECT = {
  ...SUBJECT,
  id: 's2',
  slug: 'notes',
  name: 'Notes',
};

const ARCHIVE_SUBJECT = {
  ...SUBJECT,
  id: 's3',
  slug: 'archive',
  name: 'Archive',
};

function page(slug: string, over: Record<string, unknown> = {}) {
  return {
    subjectId: 's1',
    slug,
    title: slug.toUpperCase(),
    path: `wiki/general/${slug}.md`,
    summary: `summary-${slug}`,
    contentHash: 'h',
    tags: [] as string[],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  mockGetAllPages.mockReset();
  mockGetPageBySlug.mockReset();
  mockResolvePageAlias.mockReset();
  mockResolvePageAlias.mockReturnValue(null);
  mockHybrid.mockReset();
  mockReadPage.mockReset();
  mockCreatePendingActionPreview.mockReset();
  mockCreatePendingHistoryRevertPreview.mockReset();
  mockCreatePendingWorkflowActionPreview.mockReset();
  mockReadWorkflowStatus.mockReset();
  mockListHistory.mockReset();
  mockReadHistoryDiff.mockReset();
  mockListSubjects.mockReset();
  mockGetSubjectBySlug.mockReset();
});

describe('buildQueryToolContext - Phase 3A 跨主题读取', () => {
  it('subject.list 稳定排序并只统计非 meta 页面', async () => {
    mockListSubjects.mockReturnValue([NOTES_SUBJECT, SUBJECT]);
    mockGetAllPages.mockImplementation((subjectId: string) => subjectId === 's2'
      ? [page('n1', { subjectId: 's2' }), page('idx', { subjectId: 's2', tags: ['meta'] })]
      : [page('g1'), page('g2')]);

    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    await expect(ctx.listSubjects?.()).resolves.toEqual({
      subjects: [
        { id: 's1', slug: 'general', name: 'General', description: '', pageCount: 2 },
        { id: 's2', slug: 'notes', name: 'Notes', description: '', pageCount: 1 },
      ],
    });
  });

  it('跨主题搜索拒绝 active/未知 Subject，且按 Subject 排名轮询合并', async () => {
    mockGetSubjectBySlug.mockImplementation((slug: string) => ({
      notes: NOTES_SUBJECT,
      archive: ARCHIVE_SUBJECT,
    })[slug] ?? null);
    mockHybrid.mockImplementation(async (subjectId: string) => subjectId === 's2'
      ? ['n1', 'n2']
      : ['a1', 'a2']);
    mockGetPageBySlug.mockImplementation((subjectId: string, slug: string) =>
      page(slug, { subjectId, title: slug.toUpperCase() }));

    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    await expect(ctx.searchCrossSubject?.({
      query: 'q', subjectSlugs: ['notes', 'archive'], limit: 3,
    })).resolves.toEqual({
      hits: [
        { subjectSlug: 'notes', slug: 'n1', title: 'N1', summary: 'summary-n1' },
        { subjectSlug: 'archive', slug: 'a1', title: 'A1', summary: 'summary-a1' },
        { subjectSlug: 'notes', slug: 'n2', title: 'N2', summary: 'summary-n2' },
      ],
    });
    await expect(ctx.searchCrossSubject?.({
      query: 'q', subjectSlugs: ['general'],
    })).rejects.toThrow(/active subject/i);
    await expect(ctx.searchCrossSubject?.({
      query: 'q', subjectSlugs: ['missing'],
    })).rejects.toThrow(/unknown subject/i);
  });

  it('跨主题读取只返回其他 Subject 的非 meta 非空正文', async () => {
    mockGetSubjectBySlug.mockImplementation((slug: string) =>
      slug === 'notes' ? NOTES_SUBJECT : null);
    mockGetPageBySlug.mockImplementation((_subjectId: string, slug: string) =>
      slug === 'meta' ? page(slug, { subjectId: 's2', tags: ['meta'] }) : page(slug, { subjectId: 's2' }));
    mockReadPage.mockImplementation((_subjectSlug: string, slug: string) => ({
      body: slug === 'empty' ? '  ' : `BODY-${slug}`,
    }));

    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    await expect(ctx.readCrossSubjectPage?.({ subjectSlug: 'notes', slug: 'n1' })).resolves.toEqual({
      found: true, subjectSlug: 'notes', slug: 'n1', title: 'N1', body: 'BODY-n1',
    });
    for (const slug of ['meta', 'empty']) {
      await expect(ctx.readCrossSubjectPage?.({ subjectSlug: 'notes', slug })).resolves.toEqual({
        found: false, subjectSlug: 'notes', slug, title: null, body: null,
      });
    }
    await expect(ctx.readCrossSubjectPage?.({ subjectSlug: 'general', slug: 'n1' }))
      .rejects.toThrow(/active subject/i);
  });
});

describe('buildQueryToolContext - listPages', () => {
  it('委托 evidence reader，过滤 meta 并按默认 title 排序', async () => {
    mockGetAllPages.mockReturnValue([
      page('a', { updatedAt: '2026-01-01T00:00:00Z' }),
      page('idx', { tags: ['meta'], updatedAt: '2026-09-09T00:00:00Z' }),
      page('b', { updatedAt: '2026-05-05T00:00:00Z' }),
    ]);
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    const result = await ctx.listPages();
    expect(result.pages.map((p) => p.slug)).toEqual(['a', 'b']);
    expect(result.pages.find((p) => p.slug === 'idx')).toBeUndefined();
    expect(result.nextCursor).toBeNull();
    // wiki.list tool 会对每个页调用 onAccess({ slug, title })（无 body）→ meta
    ctx.onAccess?.({ slug: 'b', title: 'B' });
    expect(accessed.meta.has('b')).toBe(true);
    expect(accessed.meta.has('idx')).toBe(false);
  });
});

describe('buildQueryToolContext - search', () => {
  it('走 hybridRankSlugs、跳过 meta、onAccess 写 accessed.meta、返回 hits', async () => {
    mockHybrid.mockResolvedValue(['b', 'meta-pg', 'gone']);
    mockGetPageBySlug.mockImplementation((_s: string, slug: string) => {
      if (slug === 'b') return page('b');
      if (slug === 'meta-pg') return page('meta-pg', { tags: ['meta'] });
      return null; // 'gone' 已删
    });
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    const hits = await ctx.search('foo', 5);
    expect(mockHybrid).toHaveBeenCalledWith('s1', 'foo', 5);
    expect(hits.map((h) => h.slug)).toEqual(['b']);
    // wiki.search tool 会对命中页调用 onAccess({ slug, title })（无 body）→ meta
    ctx.onAccess?.({ slug: 'b', title: 'B' });
    expect(accessed.meta.has('b')).toBe(true);
  });
});

describe('buildQueryToolContext - readPage', () => {
  it('命中返回 {title, markdown}；onAccess 带 body 写 accessed.bodies', async () => {
    mockGetPageBySlug.mockImplementation((_s: string, slug: string) =>
      slug === 'b' ? page('b') : null,
    );
    mockReadPage.mockImplementation((_subject: string, slug: string) =>
      slug === 'b' ? { body: 'BODY-B' } : null,
    );
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    const ok = await ctx.readPage('b');
    expect(ok).toEqual({ title: 'B', markdown: 'BODY-B' });
    // wiki.read tool 会调用 onAccess({ slug, title, body: p.markdown }) → bodies
    ctx.onAccess?.({ slug: 'b', title: 'B', body: 'BODY-B' });
    expect(accessed.bodies.get('b')?.body).toBe('BODY-B');
  });

  it('不存在/空正文返回 null', async () => {
    mockGetPageBySlug.mockImplementation(() => null);
    mockReadPage.mockImplementation(() => null);
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    const miss = await ctx.readPage('nope');
    expect(miss).toBeNull();
  });
});

describe('accessedToContext', () => {
  it('read 过的用全文；只搜索未读的按需补读；去重', () => {
    const accessed = createAccessedPages();
    accessed.bodies.set('b', { title: 'B', body: 'FULL-B' });
    accessed.meta.set('b', { title: 'B', summary: 's' }); // 同时在 meta，应去重
    accessed.meta.set('c', { title: 'C', summary: 's' }); // 仅搜索过，需补读
    mockReadPage.mockImplementation((_slug: string, slug: string) =>
      slug === 'c' ? { body: 'FULL-C' } : null,
    );
    const ctx = accessedToContext(SUBJECT, accessed);
    expect(ctx).toEqual([
      { slug: 'b', title: 'B', content: 'FULL-B' },
      { slug: 'c', title: 'C', content: 'FULL-C' },
    ]);
  });
});

describe('buildQueryToolContext - onAccess 路由', () => {
  it('body 非空 → 写 bodies，不写 meta', () => {
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onAccess?.({ slug: 'c', title: 'C', body: 'full-body' });
    expect(accessed.bodies.get('c')).toEqual({ title: 'C', body: 'full-body' });
    expect(accessed.meta.has('c')).toBe(false);
  });

  it('body 未传 → 写 meta（bodies 未收录时）', () => {
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onAccess?.({ slug: 'b', title: 'B' });
    expect(accessed.meta.has('b')).toBe(true);
    expect(accessed.bodies.has('b')).toBe(false);
  });

  it('bodies 已收录时 onAccess 不降级写 meta', () => {
    const accessed = createAccessedPages();
    accessed.bodies.set('d', { title: 'D', body: 'body-d' });
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onAccess?.({ slug: 'd', title: 'D' }); // 无 body，但 bodies 已有
    expect(accessed.meta.has('d')).toBe(false); // 不应降级写 meta
  });

  it('onSourceAccess 对相同 source/chunk 去重且不保存正文', () => {
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onSourceAccess?.({ sourceId: 'src1', chunkId: 'c0' });
    ctx.onSourceAccess?.({ sourceId: 'src1', chunkId: 'c0' });
    ctx.onSourceAccess?.({ sourceId: 'src1', chunkId: 'c1' });

    expect([...accessed.sourceRefs.values()]).toEqual([
      { sourceId: 'src1', chunkId: 'c0' },
      { sourceId: 'src1', chunkId: 'c1' },
    ]);
  });

  it('跨主题同名 slug 用复合身份存储，不覆盖 active Subject', () => {
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext(SUBJECT, accessed);
    ctx.onAccess?.({ slug: 'same', title: 'General Same', body: 'general-body' });
    ctx.onAccess?.({
      subjectSlug: 'notes', slug: 'same', title: 'Notes Same', body: 'notes-body',
    });
    expect(accessed.bodies.get('same')?.body).toBe('general-body');
    expect(accessed.crossBodies.get('notes\0same')).toEqual({
      subjectSlug: 'notes', slug: 'same', title: 'Notes Same', body: 'notes-body',
    });
  });
});

describe('buildQueryToolContext - 只读能力面', () => {
  it('不注入任何写入、删除或入队能力', () => {
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    for (const capability of ['reenrich', 'deletePage', 'createPage', 'updatePage', 'patchPage']) {
      expect(capability in ctx).toBe(false);
    }
    expect(ctx.inspectPage).toBeTypeOf('function');
    expect(ctx.searchSources).toBeTypeOf('function');
    expect(ctx.readSource).toBeTypeOf('function');
    expect(ctx.previewChange).toBeUndefined();
  });
});

describe('buildQueryToolContext - 审批预览能力面', () => {
  it('仅在提供 conversationId 时注入 subject-scoped 预览服务与回调', async () => {
    const action = { actionId: 'action-1' };
    mockCreatePendingActionPreview.mockResolvedValue(action);
    const onPendingAction = vi.fn();
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages(), {
      conversationId: 'conversation-1',
      onPendingAction,
    });
    const input = { operation: 'delete' as const, payload: { slug: 'old-page' } };

    await expect(ctx.previewChange?.(input)).resolves.toBe(action);
    expect(mockCreatePendingActionPreview).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      subject: SUBJECT,
      input,
    });
    expect(ctx.conversationId).toBe('conversation-1');
    expect(ctx.onPendingAction).toBe(onPendingAction);

    mockCreatePendingHistoryRevertPreview.mockResolvedValue(action);
    await expect(ctx.previewHistoryRevert?.('op-1')).resolves.toBe(action);
    expect(mockCreatePendingHistoryRevertPreview).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      subject: SUBJECT,
      operationId: 'op-1',
    });

    mockCreatePendingWorkflowActionPreview.mockResolvedValue(action);
    await expect(ctx.previewWorkflowReenrich?.('page-a')).resolves.toBe(action);
    await expect(ctx.previewWorkflowResearch?.('SQLite')).resolves.toBe(action);
    await expect(ctx.previewWorkflowCancel?.('job-1')).resolves.toBe(action);
    expect(mockCreatePendingWorkflowActionPreview).toHaveBeenNthCalledWith(1, {
      conversationId: 'conversation-1', subject: SUBJECT,
      input: { operation: 'workflow-reenrich-start', payload: { slug: 'page-a' } },
    });
    expect(mockCreatePendingWorkflowActionPreview).toHaveBeenNthCalledWith(2, {
      conversationId: 'conversation-1', subject: SUBJECT,
      input: { operation: 'workflow-research-start', payload: { topic: 'SQLite' } },
    });
    expect(mockCreatePendingWorkflowActionPreview).toHaveBeenNthCalledWith(3, {
      conversationId: 'conversation-1', subject: SUBJECT,
      input: { operation: 'workflow-cancel', payload: { jobId: 'job-1' } },
    });
  });
});

describe('buildQueryToolContext - History 只读能力', () => {
  it('list/diff 始终委托 active Subject 共享服务', async () => {
    mockListHistory.mockResolvedValue({ entries: [] });
    mockReadHistoryDiff.mockResolvedValue({
      operationId: 'op-1', status: 'applied', affectedPages: [], diff: 'diff',
    });
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    await ctx.listHistory?.({ slug: 'page-a', limit: 5 });
    await ctx.readHistoryDiff?.({ operationId: 'op-1' });
    expect(mockListHistory).toHaveBeenCalledWith(SUBJECT, { slug: 'page-a', limit: 5 });
    expect(mockReadHistoryDiff).toHaveBeenCalledWith(SUBJECT, { operationId: 'op-1' });
    expect(ctx.previewHistoryRevert).toBeUndefined();
  });
});

describe('buildQueryToolContext - Workflow 状态能力', () => {
  it('status 始终委托 active Subject 脱敏服务，未提供会话时不注入提案', async () => {
    mockReadWorkflowStatus.mockReturnValue({ found: false, job: null });
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    await expect(ctx.readWorkflowStatus?.('job-1')).resolves.toEqual({
      found: false, job: null,
    });
    expect(mockReadWorkflowStatus).toHaveBeenCalledWith(SUBJECT, 'job-1');
    expect(ctx.previewWorkflowReenrich).toBeUndefined();
    expect(ctx.previewWorkflowResearch).toBeUndefined();
    expect(ctx.previewWorkflowCancel).toBeUndefined();
  });
});

describe('buildQueryToolContext - webSearch', () => {
  it('委托底层 webSearch(query)', async () => {
    mockWebSearch.mockReset();
    mockWebSearch.mockResolvedValue([{ title: 'T', url: 'https://x', snippet: 'S' }]);
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    const out = await ctx.webSearch!('foo');
    expect(mockWebSearch).toHaveBeenCalledWith('foo');
    expect(out).toEqual([{ title: 'T', url: 'https://x', snippet: 'S' }]);
  });
});
