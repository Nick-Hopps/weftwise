import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Subject } from '@/lib/contracts';

const operationMocks = vi.hoisted(() => ({
  listForSubject: vi.fn(),
  getById: vi.fn(),
}));
vi.mock('../../db/repos/operations-repo', () => operationMocks);

const gitMocks = vi.hoisted(() => ({
  getVaultLog: vi.fn(),
  getDiff: vi.fn(),
  getVaultHead: vi.fn(),
  getFileAtCommit: vi.fn(),
}));
vi.mock('../../git/git-service', () => gitMocks);

const transactionMocks = vi.hoisted(() => ({
  captureSubjectMutationEpoch: vi.fn(),
  createChangeset: vi.fn(),
  validateChangeset: vi.fn(),
  applyChangeset: vi.fn(),
}));
vi.mock('../../wiki/wiki-transaction', () => transactionMocks);

import {
  applyPlannedHistoryRevert,
  listHistory,
  planHistoryRevert,
  readHistoryDiff,
} from '../history-tools';

const subject: Subject = {
  id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard', createdAt: '', updatedAt: '',
};

const rows = [
  {
    id: 'op-2', jobId: 'j2', subjectId: 's1', preHead: 'before-2', postHead: 'after-2',
    changesetJson: JSON.stringify([{ action: 'update', path: 'wiki/general/b.md', content: 'B2' }]),
    status: 'applied', jobType: 'curate',
  },
  {
    id: 'op-1', jobId: 'j1', subjectId: 's1', preHead: 'before-1', postHead: 'after-1',
    changesetJson: JSON.stringify([{ action: 'create', path: 'wiki/general/a.md', content: 'A' }]),
    status: 'applied', jobType: 'ingest',
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  operationMocks.listForSubject.mockReturnValue(rows);
  operationMocks.getById.mockReturnValue(rows[0]);
  gitMocks.getVaultLog.mockResolvedValue([
    { sha: 'after-2', date: '2026-07-14T00:02:00Z', message: '二' },
    { sha: 'after-1', date: '2026-07-14T00:01:00Z', message: '一' },
  ]);
  gitMocks.getDiff.mockResolvedValue('committed diff');
  gitMocks.getVaultHead.mockResolvedValue('current-head');
  gitMocks.getFileAtCommit.mockImplementation(async (path: string, sha: string) => {
    if (sha === 'before-2') return 'B old';
    if (sha === 'current-head') return `current:${path}`;
    throw new Error('missing');
  });
  transactionMocks.captureSubjectMutationEpoch.mockReturnValue(7);
  transactionMocks.createChangeset.mockImplementation((jobId, scopedSubject, entries, epoch) => ({
    id: 'revert-cs', jobId, subjectId: scopedSubject.id, subjectSlug: scopedSubject.slug,
    mutationEpoch: epoch, entries,
  }));
  transactionMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
  transactionMocks.applyChangeset.mockResolvedValue({ id: 'revert-cs', postHead: 'revert-head' });
});

describe('History 共享读取服务', () => {
  it('按页面 slug 过滤后应用 limit，保持最新优先', async () => {
    const result = await listHistory(subject, { slug: 'a', limit: 1 });
    expect(operationMocks.listForSubject).toHaveBeenCalledWith('s1');
    expect(result.entries.map((entry) => entry.id)).toEqual(['op-1']);
  });

  it('diff 返回 subject-scoped operation 元数据与提交差异', async () => {
    const result = await readHistoryDiff(subject, { operationId: 'op-2' });
    expect(gitMocks.getDiff).toHaveBeenCalledWith('before-2', 'after-2');
    expect(result).toMatchObject({
      operationId: 'op-2', status: 'applied', diff: 'committed diff',
      affectedPages: [{ slug: 'b', action: 'update' }],
    });
  });

  it.each([
    [null, 'not found'],
    [{ ...rows[0], subjectId: 's2' }, 'not found'],
    [{ ...rows[0], postHead: null }, 'not found'],
  ])('diff 对未知、跨 Subject 或无提交 operation 不可见', async (row, message) => {
    operationMocks.getById.mockReturnValue(row);
    await expect(readHistoryDiff(subject, { operationId: 'hidden' })).rejects.toThrow(message);
    expect(gitMocks.getDiff).not.toHaveBeenCalled();
  });
});

describe('History 回滚 plan/apply', () => {
  it('用原 preHead 与当前 HEAD 构造 inverse、预览 diff，规划阶段零写入', async () => {
    const plan = await planHistoryRevert(subject, 'op-2');
    expect(gitMocks.getFileAtCommit).toHaveBeenCalledWith('wiki/general/b.md', 'before-2');
    expect(gitMocks.getFileAtCommit).toHaveBeenCalledWith('wiki/general/b.md', 'current-head');
    expect(plan).toMatchObject({
      originalOperationId: 'op-2',
      preHead: 'current-head',
      changeset: {
        id: 'revert-cs',
        mutationEpoch: 7,
        entries: [{ action: 'update', path: 'wiki/general/b.md', content: 'B old' }],
      },
      affectedPages: [{ slug: 'b', action: 'update' }],
    });
    expect(plan.diff).toContain('-current:wiki/general/b.md');
    expect(plan.diff).toContain('+B old');
    expect(transactionMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...rows[0], status: 'reverted' }, /already reverted/i],
    [{ ...rows[0], subjectId: 's2' }, /not found/i],
    [{ ...rows[0], changesetJson: 'not-json' }, /invalid changeset/i],
  ])('拒绝不可回滚 operation', async (row, message) => {
    operationMocks.getById.mockReturnValue(row);
    await expect(planHistoryRevert(subject, 'op-2')).rejects.toThrow(message);
    expect(transactionMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('apply 在 vault 锁内核对预览 HEAD', async () => {
    const plan = await planHistoryRevert(subject, 'op-2');
    const result = await applyPlannedHistoryRevert(plan);
    expect(transactionMocks.applyChangeset).toHaveBeenCalledWith(
      plan.changeset,
      undefined,
      { expectedPreHead: 'current-head' },
    );
    expect(result).toEqual({
      originalOperationId: 'op-2',
      operationId: 'revert-cs',
      newCommitSha: 'revert-head',
      affectedSlugs: ['b'],
    });
  });
});
