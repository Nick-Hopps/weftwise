import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let previousDatabasePath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pending-action-finalizer-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

describe('finalizeAppliedPageAction', () => {
  it('embedding job 与 action applied 同事务提交，mark false/throw 均回滚 job', async () => {
    const { getRawDb } = await import('../../db/client');
    const db = getRawDb();
    const nowIso = '2026-07-13T00:00:00.000Z';
    db.prepare(`
      INSERT INTO subjects (id, slug, name, description, augmentation_level, created_at, updated_at)
      VALUES ('s1', 'subject-1', 'Subject 1', '', 'standard', ?, ?)
    `).run(nowIso, nowIso);
    db.prepare(`
      INSERT INTO conversations (id, subject_id, title, created_at, updated_at)
      VALUES ('c1', 's1', 'Conversation', ?, ?)
    `).run(nowIso, nowIso);
    const repo = await import('../../db/repos/pending-actions-repo');
    const { finalizeAppliedPageAction } = await import('../pending-action-finalizer');
    repo.createPendingAction({
      id: 'a1', conversationId: 'c1', subjectId: 's1', operation: 'delete',
      payloadJson: '{}', payloadHash: 'hash', previewJson: '{}',
      createdAt: nowIso, updatedAt: nowIso, expiresAt: '2026-07-13T00:30:00.000Z',
    });

    expect(() => finalizeAppliedPageAction({
      actionId: 'a1', subjectId: 's1', nowIso,
    })).toThrow(/executing/i);
    expect(repo.getScoped('a1', 's1')?.status).toBe('pending');
    expect(jobCount(db)).toBe(0);

    repo.claimApproval('a1', 's1', nowIso);
    repo.claimExecution('a1', 's1', 'op-1', null, nowIso);
    const mark = vi.spyOn(repo, 'markApplied').mockImplementationOnce(() => {
      throw new Error('mark failed');
    });
    expect(() => finalizeAppliedPageAction({
      actionId: 'a1', subjectId: 's1', nowIso,
    })).toThrow(/mark failed/i);
    expect(repo.getScoped('a1', 's1')?.status).toBe('executing');
    expect(jobCount(db)).toBe(0);
    mark.mockRestore();

    finalizeAppliedPageAction({ actionId: 'a1', subjectId: 's1', nowIso });
    expect(repo.getScoped('a1', 's1')).toMatchObject({
      status: 'applied', operationId: 'op-1', errorJson: null,
    });
    expect(db.prepare(`
      SELECT type, subject_id AS subjectId, params_json AS paramsJson
      FROM jobs
    `).all()).toEqual([{
      type: 'embed-index', subjectId: 's1', paramsJson: JSON.stringify({ subjectId: 's1' }),
    }]);

    expect(() => finalizeAppliedPageAction({
      actionId: 'a1', subjectId: 's1', nowIso,
    })).toThrow(/executing/i);
    expect(repo.getScoped('a1', 's1')?.status).toBe('applied');
    expect(jobCount(db)).toBe(1);
  });
});

describe('finalizeAppliedHistoryRevertAction', () => {
  it('原 operation reverted、embedding job 与 action applied 同事务提交', async () => {
    const { getRawDb } = await import('../../db/client');
    const db = getRawDb();
    const nowIso = '2026-07-14T00:00:00.000Z';
    db.prepare(`
      INSERT INTO subjects (id, slug, name, description, augmentation_level, created_at, updated_at)
      VALUES ('s1', 'subject-1', 'Subject 1', '', 'standard', ?, ?)
    `).run(nowIso, nowIso);
    db.prepare(`
      INSERT INTO conversations (id, subject_id, title, created_at, updated_at)
      VALUES ('c1', 's1', 'Conversation', ?, ?)
    `).run(nowIso, nowIso);
    db.prepare(`
      INSERT INTO operations (id, job_id, subject_id, pre_head, post_head, changeset_json, status)
      VALUES ('op-old', 'job-old', 's1', 'head-0', 'head-1', '[]', 'applied')
    `).run();
    const repo = await import('../../db/repos/pending-actions-repo');
    const { finalizeAppliedHistoryRevertAction } = await import('../pending-action-finalizer');
    repo.createPendingAction({
      id: 'a-history', conversationId: 'c1', subjectId: 's1', operation: 'history-revert',
      payloadJson: '{}', payloadHash: 'hash', previewJson: '{}',
      createdAt: nowIso, updatedAt: nowIso, expiresAt: '2026-07-14T00:30:00.000Z',
    });
    repo.claimApproval('a-history', 's1', nowIso);
    repo.claimExecution('a-history', 's1', 'op-revert', null, nowIso);

    const mark = vi.spyOn(repo, 'markApplied').mockImplementationOnce(() => {
      throw new Error('mark failed');
    });
    expect(() => finalizeAppliedHistoryRevertAction({
      actionId: 'a-history', subjectId: 's1', originalOperationId: 'op-old', nowIso,
    })).toThrow(/mark failed/i);
    expect(db.prepare(`SELECT status FROM operations WHERE id = 'op-old'`).get())
      .toEqual({ status: 'applied' });
    expect(jobCount(db)).toBe(0);
    mark.mockRestore();

    finalizeAppliedHistoryRevertAction({
      actionId: 'a-history', subjectId: 's1', originalOperationId: 'op-old', nowIso,
    });
    expect(db.prepare(`SELECT status FROM operations WHERE id = 'op-old'`).get())
      .toEqual({ status: 'reverted' });
    expect(repo.getScoped('a-history', 's1')).toMatchObject({
      status: 'applied', operationId: 'op-revert',
    });
    expect(jobCount(db)).toBe(1);
  });
});

function jobCount(db: import('better-sqlite3').Database): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM jobs`).get() as { count: number }).count;
}
