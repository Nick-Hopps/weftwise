import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../../types';
import type { ToolContext } from '../../tool-context';

const txMocks = vi.hoisted(() => ({
  createChangeset: vi.fn((_jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: 'cs-1',
    jobId: _jobId,
    subjectId: subject.id,
    subjectSlug: subject.slug,
    entries,
    preHead: 'pre',
    postHead: null,
    status: 'pending',
  })),
  applyChangeset: vi.fn(async (changeset: { entries: unknown[] }, _sourceOps?: unknown) => ({
    ...changeset,
    postHead: 'sha-1',
    status: 'applied',
  })),
}));

vi.mock('../../../../wiki/wiki-transaction', () => ({
  createChangeset: txMocks.createChangeset,
  validateChangeset: vi.fn(() => ({ valid: true, errors: [], warnings: [] })),
  applyChangeset: txMocks.applyChangeset,
  rollbackChangeset: vi.fn(async () => undefined),
}));

// Stamping looks up the existing page to preserve `created` on update.
vi.mock('../../../../db/repos/pages-repo', () => ({
  getPageBySlug: vi.fn(() => null),
}));

vi.mock('../../../../db/repos/sources-repo', () => ({
  linkPageSource: vi.fn(),
  unlinkPageSource: vi.fn(),
}));

vi.mock('../../../../sources/source-store', () => ({
  updateSourcePageLinks: vi.fn(),
}));

import { commitChangesetTool, commitPending } from '../commit-changeset';
import { parseFrontmatter } from '../../../../wiki/frontmatter';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    job: { id: 'j1', subjectId: 's1' } as AgentContext['job'],
    subject: { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as AgentContext['subject'],
    emit: vi.fn(),
    budget: { chargeStep: vi.fn(), chargeTokens: vi.fn(), assertWithin: vi.fn(), stepCount: 0, tokensUsed: 0 },
    overlay: { readPage: vi.fn(), search: vi.fn(), putEntries: vi.fn(), snapshot: vi.fn() } as unknown as AgentContext['overlay'],
    toolRegistry: { register: vi.fn(), resolve: vi.fn(), get: vi.fn() },
    skillRegistry: { get: vi.fn(), list: vi.fn(), degraded: vi.fn() },
    rootRunId: 'r1',
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 3 },
    ...overrides,
  } as AgentContext;
}

/** commitChangesetTool.handler 需要 ToolContext；将 AgentContext 包装为带 agent 字段的 ToolContext。 */
const asToolCtx = (agent: AgentContext): ToolContext => ({
  subject: agent.subject,
  readPage: async () => null,
  search: async () => [],
  listPages: async () => [],
  agent,
});

describe('commit-changeset', () => {
  it('commits once, derives commitSha from postHead, classifies pages by action, flips ctx.committed', async () => {
    const ctx = makeCtx();
    const result = await commitChangesetTool.handler({
      entries: [
        { action: 'create', path: 'wiki/general/a.md', content: '---\ntitle: A\n---\n' },
        { action: 'update', path: 'wiki/general/b.md', content: '---\ntitle: B\n---\n' },
      ],
      summary: 'add a, update b',
    }, asToolCtx(ctx));
    expect(result.commitSha).toBe('sha-1');
    expect(result.pagesCreated).toEqual(['a']);
    expect(result.pagesUpdated).toEqual(['b']);
    expect(result.linksAdded).toBe(0);
    expect(ctx.committed.value).toBe(true);
  });

  it('throws on second invocation', async () => {
    const ctx = makeCtx({ committed: { value: true } });
    await expect(commitChangesetTool.handler({
      entries: [{ action: 'create', path: 'wiki/general/a.md', content: 'x' }],
      summary: 'a',
    }, asToolCtx(ctx))).rejects.toThrow(/already invoked/);
  });

  it('stamps system-owned created/updated frontmatter before building the changeset', async () => {
    txMocks.createChangeset.mockClear();
    const ctx = makeCtx();
    await commitChangesetTool.handler({
      entries: [
        // writer-style content: title/tags only, no created/updated
        { action: 'create', path: 'wiki/general/c.md', content: '---\ntitle: C\ntags:\n  - t\n---\n\n## Body\n' },
      ],
      summary: 'add c',
    }, asToolCtx(ctx));

    const passedEntries = txMocks.createChangeset.mock.calls[0][2] as { content: string }[];
    const { data } = parseFrontmatter(passedEntries[0].content);
    expect(data.created).not.toBe('');
    expect(data.updated).not.toBe('');
    expect(data.title).toBe('C');
  });

  it('emits ingest:committing with commit metadata', async () => {
    const ctx = makeCtx();
    const emit = ctx.emit as ReturnType<typeof vi.fn>;
    await commitChangesetTool.handler({
      entries: [{ action: 'create', path: 'wiki/general/x.md', content: 'x' }],
      summary: 's',
    }, asToolCtx(ctx));
    expect(emit).toHaveBeenCalledWith('ingest:committing', expect.any(String), expect.objectContaining({
      commitSha: 'sha-1',
      pagesCreated: ['x'],
      pagesUpdated: [],
    }));
  });

  it('合并 ctx.pending（writer 暂存页）与 input.entries（reviewer 的 index/log），一并提交', async () => {
    txMocks.createChangeset.mockClear();
    const ctx = makeCtx({
      pending: { entries: [
        { action: 'create', path: 'wiki/general/page-a.md', content: '---\ntitle: A\n---\n' },
        { action: 'create', path: 'wiki/general/page-b.md', content: '---\ntitle: B\n---\n' },
      ] },
    });
    const result = await commitChangesetTool.handler({
      entries: [{ action: 'create', path: 'wiki/general/index.md', content: '---\ntitle: Index\n---\n' }],
      summary: 's',
    }, asToolCtx(ctx));
    const passed = txMocks.createChangeset.mock.calls[0][2] as { path: string }[];
    expect(passed.map((e) => e.path).sort()).toEqual([
      'wiki/general/index.md', 'wiki/general/page-a.md', 'wiki/general/page-b.md',
    ]);
    // pagesCreated 取自合并集，含未在 input 里出现的暂存页
    expect(result.pagesCreated.sort()).toEqual(['index', 'page-a', 'page-b']);
  });

  it('input.entries 按 path 覆盖 pending 暂存页（reviewer 修正版生效，去重无重复）', async () => {
    txMocks.createChangeset.mockClear();
    const ctx = makeCtx({
      pending: { entries: [
        { action: 'create', path: 'wiki/general/a.md', content: '---\ntitle: A\n---\n原始正文' },
      ] },
    });
    await commitChangesetTool.handler({
      entries: [{ action: 'create', path: 'wiki/general/a.md', content: '---\ntitle: A\n---\n修正正文' }],
      summary: 's',
    }, asToolCtx(ctx));
    const passed = txMocks.createChangeset.mock.calls[0][2] as { path: string; content: string }[];
    const a = passed.filter((e) => e.path === 'wiki/general/a.md');
    expect(a).toHaveLength(1);
    expect(a[0].content).toContain('修正正文');
  });

  it('input.entries 省略时仅提交 pending 暂存页', async () => {
    const ctx = makeCtx({
      pending: { entries: [
        { action: 'create', path: 'wiki/general/only.md', content: '---\ntitle: Only\n---\n' },
      ] },
    });
    const result = await commitChangesetTool.handler({ summary: 's' }, asToolCtx(ctx));
    expect(result.pagesCreated).toEqual(['only']);
    expect(ctx.committed.value).toBe(true);
  });

  it('pending 与 input 都为空时报错 nothing to commit', async () => {
    const ctx = makeCtx();
    await expect(commitChangesetTool.handler({ summary: 's' }, asToolCtx(ctx)))
      .rejects.toThrow(/nothing to commit/i);
  });
});

// commitPending：service 层（finalize/indexer 后）直接调用的提交入口，
// 与 tool 共享同一套合并/stamp/Saga 逻辑。tool 现为它的薄包装。
describe('commitPending', () => {
  it('合并 pending（暂存内容页）与 supplied（index/log），提交并返回 IngestResult', async () => {
    txMocks.createChangeset.mockClear();
    const ctx = makeCtx({
      pending: { entries: [
        { action: 'create', path: 'wiki/general/page-a.md', content: '---\ntitle: A\n---\n' },
      ] },
    });
    const result = await commitPending(ctx, [
      { action: 'create', path: 'wiki/general/index.md', content: '---\ntitle: Index\n---\n' },
      { action: 'create', path: 'wiki/general/log.md', content: '---\ntitle: Log\n---\n' },
    ]);
    const passed = txMocks.createChangeset.mock.calls[0][2] as { path: string }[];
    expect(passed.map((e) => e.path).sort()).toEqual([
      'wiki/general/index.md', 'wiki/general/log.md', 'wiki/general/page-a.md',
    ]);
    expect(result.commitSha).toBe('sha-1');
    expect(result.pagesCreated.sort()).toEqual(['index', 'log', 'page-a']);
    expect(ctx.committed.value).toBe(true);
  });

  it('已提交过则抛错（与 tool 共享 committed 守卫）', async () => {
    const ctx = makeCtx({ committed: { value: true } });
    await expect(commitPending(ctx, [
      { action: 'create', path: 'wiki/general/index.md', content: 'x' },
    ])).rejects.toThrow(/already invoked/);
  });
});

// SourceLinkOps 构造：Task 5 多源升级验证
describe('commitPending sourceOps', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockReset();
    txMocks.applyChangeset.mockImplementation(async (changeset: { entries: unknown[] }, _sourceOps?: unknown) => ({
      ...changeset,
      postHead: 'sha123',
      status: 'applied',
    }));
  });

  function makeIngestCtx(sourceId?: string) {
    return makeCtx({
      job: {
        id: 'job1',
        type: 'ingest',
        paramsJson: JSON.stringify(sourceId ? { sourceId } : {}),
        subjectId: 'sub1',
      } as AgentContext['job'],
      subject: { id: 'sub1', slug: 'general', name: 'General', description: '', augmentationLevel: 'standard' as const, createdAt: '', updatedAt: '' },
    });
  }

  it('merges ingest single source + web links into links[], adds extraStagePaths', async () => {
    const ctx = makeIngestCtx('src-file');
    const supplied = [{ action: 'create' as const, path: 'wiki/general/a.md', content: '---\ntitle: A\n---\n' }];
    await commitPending(ctx, supplied, {
      links: [{ sourceId: 'web-1', pageSlugs: ['a'] }],
      extraStagePaths: ['raw/general/web-x.md', '.llm-wiki/sources/general/web-1.json'],
    });
    const sourceOps = (txMocks.applyChangeset.mock.calls[0] as unknown[])[1] as {
      links: Array<{ sourceId: string; pageSlugs: string[] }>;
      extraStagePaths: string[];
    };
    expect(sourceOps.links).toEqual(
      expect.arrayContaining([
        { sourceId: 'src-file', pageSlugs: ['a'] },
        { sourceId: 'web-1', pageSlugs: ['a'] },
      ]),
    );
    expect(sourceOps.extraStagePaths).toEqual([
      'raw/general/web-x.md',
      '.llm-wiki/sources/general/web-1.json',
    ]);
  });

  it('passes undefined sourceOps when no ingest source and no web links', async () => {
    // 非 ingest 任务且无 web links，sourceOps 应为 undefined（向后兼容）
    const ctx = makeCtx({
      job: {
        id: 'job2',
        type: 'curate',
        paramsJson: '{}',
        subjectId: 'sub1',
      } as AgentContext['job'],
    });
    const supplied = [{ action: 'create' as const, path: 'wiki/general/a.md', content: '---\ntitle: A\n---\n' }];
    await commitPending(ctx, supplied);
    expect((txMocks.applyChangeset.mock.calls[0] as unknown[])[1]).toBeUndefined();
  });
});
