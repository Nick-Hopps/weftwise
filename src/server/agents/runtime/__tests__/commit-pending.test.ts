import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../types';

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
  applyChangeset: vi.fn(async (changeset: object, _sourceOps?: unknown) => ({
    ...changeset,
    postHead: 'sha-1',
    status: 'applied',
  })),
}));

vi.mock('../../../wiki/wiki-transaction', () => ({
  createChangeset: txMocks.createChangeset,
  validateChangeset: vi.fn(() => ({ valid: true, errors: [], warnings: [] })),
  applyChangeset: txMocks.applyChangeset,
}));
vi.mock('../../../db/repos/pages-repo', () => ({ getPageBySlug: vi.fn(() => null) }));
vi.mock('../../../db/repos/sources-repo', () => ({
  linkPageSource: vi.fn(),
  unlinkPageSource: vi.fn(),
}));
vi.mock('../../../sources/source-store', () => ({ updateSourcePageLinks: vi.fn() }));

import { commitPending } from '../commit-pending';
import { parseFrontmatter } from '../../../wiki/frontmatter';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    job: { id: 'j1', type: 'curate', subjectId: 's1', paramsJson: '{}' } as AgentContext['job'],
    subject: { id: 's1', slug: 'general' } as AgentContext['subject'],
    emit: vi.fn(),
    committed: { value: false },
    pending: {
      entries: [{ action: 'create', path: 'wiki/general/page-a.md', content: '---\ntitle: A\n---\n' }],
    },
    ...overrides,
  } as AgentContext;
}

describe('commitPending', () => {
  beforeEach(() => {
    txMocks.createChangeset.mockClear();
    txMocks.applyChangeset.mockClear();
  });

  it('合并 pending 与 supplied 后通过同一个 changeset 提交', async () => {
    const ctx = makeCtx();
    const result = await commitPending(ctx, [
      { action: 'create', path: 'wiki/general/index.md', content: '---\ntitle: Index\n---\n' },
    ]);

    const entries = txMocks.createChangeset.mock.calls[0][2] as Array<{ path: string }>;
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      'wiki/general/index.md',
      'wiki/general/page-a.md',
    ]);
    expect(result.commitSha).toBe('sha-1');
    expect(ctx.committed.value).toBe(true);
  });

  it('拒绝重复调用以及空提交', async () => {
    await expect(commitPending(makeCtx({ committed: { value: true } }), []))
      .rejects.toThrow(/already invoked/);
    await expect(commitPending(makeCtx({ pending: { entries: [] } }), []))
      .rejects.toThrow(/nothing to commit/);
  });

  it('supplied 按 path 覆盖 pending，并补齐系统 frontmatter', async () => {
    const ctx = makeCtx({
      pending: {
        entries: [{ action: 'create', path: 'wiki/general/page-a.md', content: '---\ntitle: A\n---\n旧正文' }],
      },
    });
    await commitPending(ctx, [
      { action: 'create', path: 'wiki/general/page-a.md', content: '---\ntitle: A\n---\n新正文' },
    ]);

    const entries = txMocks.createChangeset.mock.calls[0][2] as Array<{ path: string; content: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain('新正文');
    const { data } = parseFrontmatter(entries[0].content);
    expect(data.created).toBeTruthy();
    expect(data.updated).toBeTruthy();
  });

  it('把 ingest 文件源与网页源合并进 SourceLinkOps', async () => {
    const ctx = makeCtx({
      job: {
        id: 'job-ingest',
        type: 'ingest',
        subjectId: 's1',
        paramsJson: JSON.stringify({ sourceId: 'source-file' }),
      } as AgentContext['job'],
    });
    await commitPending(ctx, [], {
      links: [{ sourceId: 'source-web', pageSlugs: ['page-a'] }],
      extraStagePaths: ['raw/general/web.md'],
    });

    const sourceOps = txMocks.applyChangeset.mock.calls[0][1] as {
      links: Array<{ sourceId: string; pageSlugs: string[] }>;
      extraStagePaths: string[];
    };
    expect(sourceOps.links).toEqual(expect.arrayContaining([
      { sourceId: 'source-file', pageSlugs: ['page-a'] },
      { sourceId: 'source-web', pageSlugs: ['page-a'] },
    ]));
    expect(sourceOps.extraStagePaths).toEqual(['raw/general/web.md']);
  });

  it('无来源操作时向 Saga 传入 undefined', async () => {
    await commitPending(makeCtx(), []);
    expect(txMocks.applyChangeset.mock.calls[0][1]).toBeUndefined();
  });
});

describe('commitPending — quiz 分隔符终审（零成本、只观测）', () => {
  const SPOILED = '---\ntitle: A\n---\n\n> [!quiz] 检验理解\n> 问：为什么？\n> 答：因为忽里勒台。\n';
  const OK = '---\ntitle: A\n---\n\n> [!quiz] ❓ 自测\n> 问：为什么？\n>\n> ---\n>\n> 答：因为忽里勒台。\n';

  beforeEach(() => {
    txMocks.createChangeset.mockClear();
    txMocks.applyChangeset.mockClear();
  });

  function quizWarns(ctx: AgentContext): unknown[][] {
    return (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'ingest:warn' && String(c[1]).includes('Quiz answer separator'),
    );
  }

  it('最终内容仍有受损 quiz → emit warn 带 path 与违规明细', async () => {
    const ctx = makeCtx({
      pending: { entries: [{ action: 'create', path: 'wiki/general/page-a.md', content: SPOILED }] },
    });
    await commitPending(ctx, []);

    const warns = quizWarns(ctx);
    expect(warns).toHaveLength(1);
    expect(String(warns[0][1])).toContain('wiki/general/page-a.md');
    const data = warns[0][2] as { path: string; violations: Array<{ reason: string }> };
    expect(data.path).toBe('wiki/general/page-a.md');
    expect(data.violations.map((v) => v.reason)).toEqual(['missing-separator']);
  });

  it('终审只观测：不改动提交内容，也不阻断提交', async () => {
    const ctx = makeCtx({
      pending: { entries: [{ action: 'create', path: 'wiki/general/page-a.md', content: SPOILED }] },
    });
    const result = await commitPending(ctx, []);

    expect(result.commitSha).toBe('sha-1');
    const entries = txMocks.createChangeset.mock.calls[0][2] as Array<{ content: string }>;
    // 只有系统 frontmatter 戳记，正文部分逐字保留（分隔符没有被偷偷补上）
    expect(entries[0].content).toContain('> 答：因为忽里勒台。');
    expect(entries[0].content).not.toContain('> ---');
  });

  it('内容守约时不产生 warn 噪音', async () => {
    const ctx = makeCtx({
      pending: { entries: [{ action: 'create', path: 'wiki/general/page-a.md', content: OK }] },
    });
    await commitPending(ctx, []);
    expect(quizWarns(ctx)).toHaveLength(0);
  });

  it('delete 条目没有 content，不参与终审', async () => {
    const ctx = makeCtx({
      pending: { entries: [{ action: 'delete', path: 'wiki/general/page-a.md', content: null }] },
    });
    await commitPending(ctx, []);
    expect(quizWarns(ctx)).toHaveLength(0);
  });
});
