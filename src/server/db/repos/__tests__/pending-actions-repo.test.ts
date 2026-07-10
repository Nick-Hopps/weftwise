import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingActionPreview } from '@/lib/contracts';

let dir: string;
let previousDatabasePath: string | undefined;

const preview: PendingActionPreview = {
  kind: 'page-change',
  preHead: 'head-1',
  summary: '删除 page-a',
  affectedPages: [{ slug: 'page-a', action: 'delete' }],
  diff: 'diff',
  warnings: [],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-actions-repo-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { getRawDb } = await import('../../client');
  const db = getRawDb();
  const now = '2026-07-11T00:00:00.000Z';
  db.prepare(
    `INSERT INTO subjects (id, slug, name, description, augmentation_level, created_at, updated_at)
     VALUES ('s1', 'subject-1', 'Subject 1', '', 'standard', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO conversations (id, subject_id, title, created_at, updated_at)
     VALUES ('c1', 's1', 'Conversation 1', ?, ?)`,
  ).run(now, now);
  const repo = await import('../pending-actions-repo');
  return { db, repo, now };
}

async function createPending(overrides: Record<string, unknown> = {}) {
  const ctx = await setup();
  const action = ctx.repo.createPendingAction({
    id: 'a1',
    conversationId: 'c1',
    subjectId: 's1',
    operation: 'delete',
    payloadJson: '{"slug":"page-a"}',
    payloadHash: 'hash-1',
    previewJson: JSON.stringify(preview),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    expiresAt: '2026-07-11T00:30:00.000Z',
    ...overrides,
  });
  return { ...ctx, action };
}

describe('pending-actions-repo', () => {
  it('创建并按 conversation/subject 读取审批记录', async () => {
    const { repo, action } = await createPending();
    expect(action).toMatchObject({
      id: 'a1', conversationId: 'c1', subjectId: 's1', status: 'pending', operation: 'delete',
    });
    expect(repo.getScoped('a1', 's1')?.payloadHash).toBe('hash-1');
    expect(repo.getScoped('a1', 'other')).toBeNull();
    expect(repo.listForConversation('c1', 's1')).toHaveLength(1);
    expect(repo.listForConversation('c1', 'other')).toEqual([]);
  });

  it('批准与执行均为条件抢占且只能成功一次', async () => {
    const { repo, now } = await createPending();
    expect(repo.claimApproval('a1', 's1', now)?.status).toBe('approved');
    expect(repo.claimApproval('a1', 's1', now)).toBeNull();

    expect(repo.claimExecution('a1', 's1', 'op-1', null, now)).toBe(true);
    expect(repo.claimExecution('a1', 's1', 'op-2', null, now)).toBe(false);
    expect(repo.getScoped('a1', 's1')).toMatchObject({
      status: 'executing', operationId: 'op-1', jobId: null,
    });
  });

  it('stale HEAD 刷新预览时 approved 回到 pending 并清空批准字段', async () => {
    const { repo, now } = await createPending();
    repo.claimApproval('a1', 's1', now);
    const refreshed = { ...preview, preHead: 'head-2', summary: '刷新后的删除预览' };
    expect(repo.refreshPreview({
      id: 'a1',
      subjectId: 's1',
      payloadHash: 'hash-2',
      previewJson: JSON.stringify(refreshed),
      expiresAt: '2026-07-11T00:45:00.000Z',
      updatedAt: '2026-07-11T00:15:00.000Z',
    })).toBe(true);
    expect(repo.getScoped('a1', 's1')).toMatchObject({
      status: 'pending', approvedAt: null, operationId: null, payloadHash: 'hash-2',
    });
  });

  it('拒绝、过期、失败与成功只接受合法来源状态', async () => {
    const rejected = await createPending();
    expect(rejected.repo.rejectPending('a1', 's1', rejected.now)).toBe(true);
    expect(rejected.repo.rejectPending('a1', 's1', rejected.now)).toBe(false);
    expect(rejected.repo.getScoped('a1', 's1')?.status).toBe('rejected');

    vi.resetModules();
    process.env.DATABASE_PATH = join(dir, 'wiki-expiry.db');
    const expired = await createPending({ expiresAt: '2026-07-10T23:59:59.000Z' });
    expect(expired.repo.expirePending(expired.now)).toBe(1);
    expect(expired.repo.getScoped('a1', 's1')?.status).toBe('expired');

    vi.resetModules();
    process.env.DATABASE_PATH = join(dir, 'wiki-applied.db');
    const applied = await createPending();
    applied.repo.claimApproval('a1', 's1', applied.now);
    applied.repo.claimExecution('a1', 's1', 'op-1', null, applied.now);
    expect(applied.repo.markApplied('a1', 's1', applied.now)).toBe(true);
    expect(applied.repo.markFailed('a1', 's1', '{"code":"x"}', applied.now)).toBe(false);
    expect(applied.repo.getScoped('a1', 's1')?.status).toBe('applied');
  });

  it('Conversation 删除级联审批记录，终态按 cutoff 清理', async () => {
    const { db, repo, now } = await createPending();
    repo.claimApproval('a1', 's1', now);
    repo.claimExecution('a1', 's1', 'op-1', null, now);
    repo.markApplied('a1', 's1', now);
    expect(repo.pruneTerminal('2026-07-12T00:00:00.000Z')).toBe(1);

    repo.createPendingAction({
      id: 'a2', conversationId: 'c1', subjectId: 's1', operation: 'delete',
      payloadJson: '{}', payloadHash: 'h2', previewJson: JSON.stringify(preview),
      createdAt: now, updatedAt: now, expiresAt: '2026-07-11T00:30:00.000Z',
    });
    db.prepare(`DELETE FROM conversations WHERE id = 'c1'`).run();
    expect(repo.getScoped('a2', 's1')).toBeNull();
  });
});
