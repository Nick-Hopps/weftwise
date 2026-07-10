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
