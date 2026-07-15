import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

let dir: string;
let previousDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'research-provenance-repo-'));
  previousDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDb;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { getRawDb } = await import('../../client');
  const sqlite = getRawDb();
  const now = '2026-07-14T00:00:00.000Z';
  const insertSubject = sqlite.prepare(`
    INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, ?)
  `);
  insertSubject.run('s1', 'subject-one', 'Subject One', now, now);
  insertSubject.run('s2', 'other', 'Other', now, now);
  const provenance = await import('../../../services/research-provenance');
  const findingIdentity = await import('../../../services/finding-identity');
  const repo = await import('../research-provenance-repo');
  return { sqlite, provenance, findingIdentity, repo };
}

describe('research-provenance-repo run 持久化', () => {
  it('在同一事务写入 run、finding 快照、topics/queries 与稳定 candidates', async () => {
    const { repo, provenance, findingIdentity } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a/', title: 'A', snippet: 'a', score: 3, reason: 'great' },
    ]);
    const finding = {
      type: 'coverage-gap' as const,
      severity: 'info' as const,
      pageSlug: 'distributed-systems',
      targetSlug: 'distributed-systems-reliability',
      evidence: [
        { pageSlug: 'distributed-systems', quote: 'Retries need bounded backoff.' },
        { pageSlug: 'operations', quote: 'Reliability requires failure budgets.' },
      ],
      description: 'Needs sources',
      suggestedFix: null,
      subjectSlug: 'subject-one',
    };

    const findingId = findingIdentity.findingId({ ...finding, subjectId: 's1' });
    const stored = repo.persistResearchRun({
      subjectId: 's1',
      researchJobId: 'research-1',
      origin: 'findings',
      lintJobId: 'lint-1',
      topic: null,
      topics: ['Needs sources'],
      queries: ['distributed systems sources'],
      findings: [{ findingId, snapshot: finding }],
      candidates,
    });

    expect(stored.run).toMatchObject({
      subjectId: 's1',
      researchJobId: 'research-1',
      origin: 'findings',
      lintJobId: 'lint-1',
      status: 'awaiting-approval',
      version: 1,
    });
    expect(JSON.parse(stored.run.topicsJson)).toEqual(['Needs sources']);
    expect(JSON.parse(stored.run.queriesJson)).toEqual(['distributed systems sources']);
    expect(stored.findings).toHaveLength(1);
    expect(JSON.parse(stored.findings[0]!.snapshotJson)).toEqual(finding);
    expect(stored.candidates).toHaveLength(1);
    expect(stored.candidates[0]).toMatchObject({
      id: provenance.researchCandidateId(stored.run.id, 'https://example.com/a'),
      normalizedUrl: 'https://example.com/a',
      rank: 0,
      decision: 'pending',
    });
  });

  it('同 researchJobId 与相同候选集幂等返回，不重复写行', async () => {
    const { repo, provenance, sqlite } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const input = {
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic' as const,
      lintJobId: null, topic: 'A', topics: ['A'], queries: ['A query'], findings: [], candidates,
    };
    const first = repo.persistResearchRun(input);
    const replay = repo.persistResearchRun(input);

    expect(replay.run.id).toBe(first.run.id);
    expect(sqlite.prepare('SELECT count(*) AS count FROM research_runs').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT count(*) AS count FROM research_candidates').get()).toEqual({ count: 1 });
  });

  it('同 researchJobId 的候选集 hash 漂移时拒绝覆盖原快照', async () => {
    const { repo, provenance } = await setup();
    const base = {
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic' as const,
      lintJobId: null, topic: 'A', topics: ['A'], queries: ['A query'], findings: [],
    };
    repo.persistResearchRun({
      ...base,
      candidates: provenance.prepareResearchCandidates([
        { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
      ]),
    });

    expect(() => repo.persistResearchRun({
      ...base,
      candidates: provenance.prepareResearchCandidates([
        { url: 'https://example.com/b', title: 'B', snippet: 'b', score: 3, reason: null },
      ]),
    })).toThrowError(expect.objectContaining({ code: 'candidate-set-conflict' }));
    expect(repo.findResearchRunByJobId('research-1', 's1')!.candidates[0]!.normalizedUrl)
      .toBe('https://example.com/a');
  });

  it('空候选持久化为 empty，并按 subject 隔离读取', async () => {
    const { repo } = await setup();
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-empty', origin: 'topic',
      lintJobId: null, topic: 'none', topics: ['none'], queries: ['none'], findings: [], candidates: [],
    });
    expect(stored.run.status).toBe('empty');
    expect(repo.findResearchRunById(stored.run.id, 's2')).toBeNull();
    expect(repo.findResearchRunByJobId('research-empty', 's2')).toBeNull();
  });

  it('按 researchJobId 批量恢复时保持请求顺序、去重并隔离 subject', async () => {
    const { repo } = await setup();
    for (const researchJobId of ['research-a', 'research-b']) {
      repo.persistResearchRun({
        subjectId: 's1', researchJobId, origin: 'topic', lintJobId: null,
        topic: researchJobId, topics: [researchJobId], queries: ['query'],
        findings: [], candidates: [],
      });
    }
    expect(repo.findResearchRunsByJobIds(
      ['research-b', 'missing', 'research-a', 'research-b'],
      's1',
    ).map((stored) => stored.run.researchJobId)).toEqual(['research-b', 'research-a']);
    expect(repo.findResearchRunsByJobIds(['research-a'], 's2')).toEqual([]);
    expect(repo.findResearchRunsByJobIds([], 's1')).toEqual([]);
  });

  it('公开读取在同一 DEFERRED 快照中 hydrate，跨连接提交不会产生 torn state', async () => {
    const { repo, provenance, sqlite } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-snapshot', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    const other = new Database(process.env.DATABASE_PATH!);
    other.pragma('foreign_keys = ON');
    other.pragma('journal_mode = WAL');
    const mutableSqlite = sqlite as unknown as {
      prepare: (source: string) => ReturnType<typeof sqlite.prepare>;
    };
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let committed = false;
    mutableSqlite.prepare = (source: string) => {
      if (!committed && source.includes('FROM research_run_findings')) {
        other.transaction(() => {
          const now = '2026-07-14T01:00:00.000Z';
          other.prepare(`
            UPDATE research_candidates SET decision = 'rejected', decided_at = ?
            WHERE run_id = ?
          `).run(now, stored.run.id);
          other.prepare(`
            UPDATE research_runs
            SET status = 'dismissed', version = 2, updated_at = ?, completed_at = ?
            WHERE id = ?
          `).run(now, now, stored.run.id);
        }).immediate();
        committed = true;
      }
      return originalPrepare(source);
    };

    try {
      const snapshot = repo.findResearchRunById(stored.run.id, 's1')!;
      expect(committed).toBe(true);
      expect(snapshot.run).toMatchObject({ status: 'awaiting-approval', version: 1 });
      expect(snapshot.candidates[0]).toMatchObject({ decision: 'pending', decidedAt: null });
    } finally {
      mutableSqlite.prepare = originalPrepare;
      other.close();
    }

    const latest = repo.findResearchRunById(stored.run.id, 's1')!;
    expect(latest.run).toMatchObject({ status: 'dismissed', version: 2 });
    expect(latest.candidates[0]).toMatchObject({ decision: 'rejected' });
  });

  it('任一 candidate 写入失败会回滚整个 run', async () => {
    const { repo, provenance, sqlite } = await setup();
    const candidate = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ])[0]!;
    expect(() => repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-bad', origin: 'topic',
      lintJobId: null, topic: 'bad', topics: ['bad'], queries: ['bad'], findings: [],
      candidates: [candidate, { ...candidate, rank: 1 }],
    })).toThrow();
    expect(sqlite.prepare('SELECT count(*) AS count FROM research_runs').get()).toEqual({ count: 0 });
  });
});

describe('research-provenance-repo 原子批准与驳回', () => {
  it('真实 service/repo 集成可读取、批准并幂等恢复同一 coordinator', async () => {
    const { repo, provenance } = await setup();
    const service = await import('../../../services/research-approval-service');
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-integration', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    expect(service.getResearchRun(stored.run.id, 's1')).toMatchObject({
      status: 'awaiting-approval',
      version: 1,
    });
    const input = {
      runId: stored.run.id,
      subjectId: 's1',
      candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1,
      idempotencyKey: 'integration-key',
    };
    const first = service.approveResearchRun(input);
    const replay = service.approveResearchRun(input);
    expect(first).toMatchObject({ replayed: false, run: { status: 'importing', version: 2 } });
    expect(replay).toMatchObject({ replayed: true, coordinatorJobId: first.coordinatorJobId });
  });

  it.each([
    'snapshot-json',
    'normalized-url',
    'candidate-id',
    'rank',
    'candidate-set-hash',
  ] as const)('%s 漂移时批准 fail-closed 且不产生任何部分写入', async (mutation) => {
    const { repo, provenance, sqlite } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-corrupt', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    if (mutation === 'snapshot-json') {
      sqlite.prepare('UPDATE research_candidates SET snapshot_json = ? WHERE run_id = ?')
        .run('{', stored.run.id);
    } else if (mutation === 'normalized-url') {
      sqlite.prepare('UPDATE research_candidates SET normalized_url = ? WHERE run_id = ?')
        .run('https://example.com/changed', stored.run.id);
    } else if (mutation === 'candidate-id') {
      sqlite.prepare('UPDATE research_candidates SET id = ? WHERE run_id = ?')
        .run('a'.repeat(64), stored.run.id);
    } else if (mutation === 'rank') {
      sqlite.prepare('UPDATE research_candidates SET rank = 1 WHERE run_id = ?')
        .run(stored.run.id);
    } else {
      sqlite.prepare('UPDATE research_runs SET candidate_set_hash = ? WHERE id = ?')
        .run('0'.repeat(64), stored.run.id);
    }
    const candidate = sqlite.prepare('SELECT id FROM research_candidates WHERE run_id = ?')
      .get(stored.run.id) as { id: string };

    expect(() => repo.approveResearchRunAtomic({
      runId: stored.run.id,
      subjectId: 's1',
      candidateIds: [candidate.id],
      expectedVersion: 1,
      idempotencyKey: `approve-${mutation}`,
    })).toThrow();
    expect(sqlite.prepare('SELECT count(*) AS count FROM research_approvals').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT count(*) AS count FROM research_candidate_ingests').get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'research-import'").get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT status, version FROM research_runs WHERE id = ?').get(stored.run.id))
      .toEqual({ status: 'awaiting-approval', version: 1 });
  });

  it('在同一事务创建 approval、decisions、deliveries 与 coordinator job', async () => {
    const { repo, provenance, sqlite } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
      { url: 'https://example.com/b', title: 'B', snippet: 'b', score: 2, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    const selected = stored.candidates[1]!.id;
    const approved = repo.approveResearchRunAtomic({
      runId: stored.run.id,
      subjectId: 's1',
      candidateIds: [selected],
      expectedVersion: 1,
      idempotencyKey: 'approve-1',
    });

    expect(approved.replayed).toBe(false);
    expect(approved.stored.run).toMatchObject({ status: 'importing', version: 2 });
    expect(approved.stored.approval).toMatchObject({ coordinatorJobId: approved.coordinatorJobId });
    expect(approved.stored.candidates.map((candidate) => candidate.decision))
      .toEqual(['rejected', 'approved']);
    expect(approved.stored.deliveries).toHaveLength(1);
    expect(approved.stored.deliveries[0]).toMatchObject({
      candidateId: selected,
      status: 'pending',
      normalizedUrl: 'https://example.com/b',
    });
    const coordinatorJob = sqlite.prepare('SELECT * FROM jobs WHERE id = ?')
      .get(approved.coordinatorJobId) as Record<string, unknown>;
    expect(coordinatorJob).toMatchObject({ type: 'research-import', status: 'pending', subject_id: 's1' });
    expect(JSON.parse(String(coordinatorJob.params_json))).toEqual({
      approvalId: approved.stored.approval!.id,
      runId: stored.run.id,
      subjectId: 's1',
    });
    expect(sqlite.prepare('SELECT count(*) AS count FROM research_approvals').get()).toEqual({ count: 1 });
  });

  it('先处理同 key/hash 幂等重放，再检查已递增的 version', async () => {
    const { repo, provenance } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    const input = {
      runId: stored.run.id, subjectId: 's1', candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1, idempotencyKey: 'approve-1',
    };
    const first = repo.approveResearchRunAtomic(input);
    const replay = repo.approveResearchRunAtomic(input);
    expect(replay.replayed).toBe(true);
    expect(replay.stored.approval!.id).toBe(first.stored.approval!.id);
    expect(replay.coordinatorJobId).toBe(first.coordinatorJobId);
  });

  it('幂等重放时 approval selection 快照损坏会 fail-closed', async () => {
    const { repo, provenance, sqlite } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    const input = {
      runId: stored.run.id, subjectId: 's1', candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1, idempotencyKey: 'approve-1',
    };
    repo.approveResearchRunAtomic(input);
    sqlite.prepare('UPDATE research_approvals SET selected_candidate_ids_json = ? WHERE run_id = ?')
      .run('[]', stored.run.id);

    expect(() => repo.approveResearchRunAtomic(input)).toThrow();
    expect(sqlite.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'research-import'").get())
      .toEqual({ count: 1 });
  });

  it('同 key 不同 payload、不同 key 重复批准分别拒绝', async () => {
    const { repo, provenance } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
      { url: 'https://example.com/b', title: 'B', snippet: 'b', score: 2, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    repo.approveResearchRunAtomic({
      runId: stored.run.id, subjectId: 's1', candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1, idempotencyKey: 'approve-1',
    });
    expect(() => repo.approveResearchRunAtomic({
      runId: stored.run.id, subjectId: 's1', candidateIds: [stored.candidates[1]!.id],
      expectedVersion: 1, idempotencyKey: 'approve-1',
    })).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }));
    expect(() => repo.approveResearchRunAtomic({
      runId: stored.run.id, subjectId: 's1', candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1, idempotencyKey: 'approve-2',
    })).toThrowError(expect.objectContaining({ code: 'already-approved' }));
  });

  it('拒绝 stale version、未知 candidate 与跨 subject run', async () => {
    const { repo, provenance } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    expect(() => repo.approveResearchRunAtomic({
      runId: stored.run.id, subjectId: 's1', candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 0, idempotencyKey: 'stale',
    })).toThrowError(expect.objectContaining({ code: 'run-stale' }));
    expect(() => repo.approveResearchRunAtomic({
      runId: stored.run.id, subjectId: 's1', candidateIds: ['missing'],
      expectedVersion: 1, idempotencyKey: 'unknown',
    })).toThrowError(expect.objectContaining({ code: 'selection-invalid' }));
    expect(() => repo.approveResearchRunAtomic({
      runId: stored.run.id, subjectId: 's2', candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1, idempotencyKey: 'cross-subject',
    })).toThrowError(expect.objectContaining({ code: 'run-not-found' }));
  });

  it('dismiss 只允许 awaiting-approval，原子拒绝全部 pending candidates', async () => {
    const { repo, provenance } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
      { url: 'https://example.com/b', title: 'B', snippet: 'b', score: 2, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    const dismissed = repo.dismissResearchRunAtomic(stored.run.id, 's1');
    expect(dismissed.run).toMatchObject({ status: 'dismissed', version: 2 });
    expect(dismissed.candidates.every((candidate) => candidate.decision === 'rejected')).toBe(true);
    expect(() => repo.dismissResearchRunAtomic(stored.run.id, 's1'))
      .toThrowError(expect.objectContaining({ code: 'run-not-approvable' }));
  });

  it('coordinator job 插入失败时回滚 approval、decision 与 delivery', async () => {
    const { repo, provenance, sqlite } = await setup();
    const candidates = provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-1', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    sqlite.exec(`
      CREATE TRIGGER fail_research_import
      BEFORE INSERT ON jobs WHEN NEW.type = 'research-import'
      BEGIN SELECT RAISE(ABORT, 'coordinator insert failed'); END
    `);

    expect(() => repo.approveResearchRunAtomic({
      runId: stored.run.id,
      subjectId: 's1',
      candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1,
      idempotencyKey: 'approve-rollback',
    })).toThrow(/coordinator insert failed/);

    const reloaded = repo.findResearchRunById(stored.run.id, 's1')!;
    expect(reloaded.run).toMatchObject({ status: 'awaiting-approval', version: 1 });
    expect(reloaded.approval).toBeNull();
    expect(reloaded.deliveries).toEqual([]);
    expect(reloaded.candidates[0]).toMatchObject({ decision: 'pending', approvalId: null });
  });
});

describe('research-provenance-repo delivery 租约', () => {
  async function createDelivery() {
    const context = await setup();
    const candidates = context.provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = context.repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-delivery', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    const approved = context.repo.approveResearchRunAtomic({
      runId: stored.run.id,
      subjectId: 's1',
      candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1,
      idempotencyKey: 'approve-delivery',
    });
    return {
      ...context,
      runId: stored.run.id,
      approvalId: approved.stored.approval!.id,
      candidateId: stored.candidates[0]!.id,
    };
  }

  it('pending 可 claim，并写入 token、lease 与 attempt count', async () => {
    const { repo, approvalId, candidateId } = await createDelivery();
    const claim = repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T01:00:00.000Z'),
      leaseMs: 30_000,
    });

    expect(claim).toMatchObject({
      approvalId,
      candidateId,
      status: 'fetching',
      attemptCount: 1,
      leaseExpiresAt: '2026-07-14T01:00:30.000Z',
    });
    expect(claim!.claimToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('未过期 fetching 不可重复 claim，过期后生成新 token 并递增 attempt', async () => {
    const { repo, approvalId, candidateId } = await createDelivery();
    const first = repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T01:00:00.000Z'),
      leaseMs: 30_000,
    })!;

    expect(repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T01:00:29.999Z'),
      leaseMs: 30_000,
    })).toBeNull();

    const reclaimed = repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T01:00:30.000Z'),
      leaseMs: 60_000,
    })!;
    expect(reclaimed).toMatchObject({
      status: 'fetching',
      attemptCount: 2,
      leaseExpiresAt: '2026-07-14T01:01:30.000Z',
    });
    expect(reclaimed.claimToken).not.toBe(first.claimToken);
  });

  it('旧 token 的续租、失败与 source/job queued 回写全部被 CAS 拒绝', async () => {
    const { repo, sqlite, approvalId, candidateId } = await createDelivery();
    const first = repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T01:00:00.000Z'),
      leaseMs: 1_000,
    })!;
    const current = repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T01:00:01.000Z'),
      leaseMs: 30_000,
    })!;

    expect(repo.renewResearchDeliveryClaim({
      approvalId,
      candidateId,
      claimToken: first.claimToken!,
      now: new Date('2026-07-14T01:00:02.000Z'),
      leaseMs: 30_000,
    })).toBe(false);
    expect(repo.failResearchDeliveryClaim({
      approvalId,
      candidateId,
      claimToken: first.claimToken!,
      now: new Date('2026-07-14T01:00:02.000Z'),
      error: { code: 'FETCH_FAILED', message: '旧请求失败' },
    })).toBe(false);

    const transaction = sqlite.transaction(() => repo.markResearchDeliveryQueuedInTransaction(
      sqlite,
      {
        approvalId,
        candidateId,
        claimToken: first.claimToken!,
        sourceId: 'source-old',
        ingestJobId: 'job-old',
        now: new Date('2026-07-14T01:00:02.000Z'),
      },
    ));
    expect(() => transaction.immediate()).toThrow(/claim/i);

    const delivery = repo.findResearchRunById(current.runId)!.deliveries[0]!;
    expect(delivery).toMatchObject({
      status: 'fetching',
      claimToken: current.claimToken,
      sourceId: null,
      ingestJobId: null,
      attemptCount: 2,
    });
  });

  it('当前 token 可续租、失败，并在终态后拒绝重复写入', async () => {
    const { repo, approvalId, candidateId } = await createDelivery();
    const claim = repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T01:00:00.000Z'),
      leaseMs: 30_000,
    })!;

    expect(repo.renewResearchDeliveryClaim({
      approvalId,
      candidateId,
      claimToken: claim.claimToken!,
      now: new Date('2026-07-14T01:00:10.000Z'),
      leaseMs: 60_000,
    })).toBe(true);
    expect(repo.failResearchDeliveryClaim({
      approvalId,
      candidateId,
      claimToken: claim.claimToken!,
      now: new Date('2026-07-14T01:00:11.000Z'),
      error: { code: 'FETCH_FAILED', message: '抓取失败' },
    })).toBe(true);
    expect(repo.failResearchDeliveryClaim({
      approvalId,
      candidateId,
      claimToken: claim.claimToken!,
      now: new Date('2026-07-14T01:00:12.000Z'),
      error: { code: 'FETCH_FAILED', message: '重复失败' },
    })).toBe(false);
  });
});

describe('research-provenance-repo failed run 导入重试', () => {
  async function createFailedTopicRun() {
    const context = await setup();
    const candidates = context.provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]);
    const stored = context.repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-retry', origin: 'topic', lintJobId: null,
      topic: 'A', topics: ['A'], queries: ['A'], findings: [], candidates,
    });
    const approved = context.repo.approveResearchRunAtomic({
      runId: stored.run.id,
      subjectId: 's1',
      candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1,
      idempotencyKey: 'approve-retry',
    });
    const approvalId = approved.stored.approval!.id;
    const candidateId = stored.candidates[0]!.id;
    const claim = context.repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T01:00:00.000Z'),
      leaseMs: 30_000,
    })!;
    expect(context.repo.failResearchDeliveryClaim({
      approvalId,
      candidateId,
      claimToken: claim.claimToken!,
      now: new Date('2026-07-14T01:00:01.000Z'),
      error: { code: 'FETCH_FAILED', message: '抓取失败' },
    })).toBe(true);
    expect(context.repo.finalizeTopicResearchRunAtomic(
      stored.run.id,
      new Date('2026-07-14T01:00:02.000Z'),
    )).toBe(true);
    return { ...context, runId: stored.run.id, approvalId, candidateId };
  }

  async function createFailedChildTopicRun() {
    const context = await setup();
    const candidates = context.provenance.prepareResearchCandidates([
      { url: 'https://example.com/child', title: 'Child', snippet: 'child', score: 3, reason: null },
    ]);
    const stored = context.repo.persistResearchRun({
      subjectId: 's1', researchJobId: 'research-child-retry', origin: 'topic', lintJobId: null,
      topic: 'Child', topics: ['Child'], queries: ['Child'], findings: [], candidates,
    });
    const approved = context.repo.approveResearchRunAtomic({
      runId: stored.run.id,
      subjectId: 's1',
      candidateIds: [stored.candidates[0]!.id],
      expectedVersion: 1,
      idempotencyKey: 'approve-child-retry',
    });
    const approvalId = approved.stored.approval!.id;
    const candidateId = stored.candidates[0]!.id;
    const ingestJobId = 'ingest-child-retry';
    const now = '2026-07-14T01:00:00.000Z';
    context.sqlite.prepare(`
      INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json)
      VALUES ('source-child-retry', 's1', 'child.html', 'hash-child', ?, '{}')
    `).run(now);
    context.sqlite.prepare(`
      INSERT INTO jobs (
        id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count,
        cancel_requested
      ) VALUES (?, 'ingest', 'failed', 's1', ?, ?, ?, ?, ?, NULL, NULL, 2, 0)
    `).run(
      ingestJobId,
      JSON.stringify({
        sourceId: 'source-child-retry',
        filename: 'child.html',
        subjectId: 's1',
        researchProvenance: { runId: stored.run.id, approvalId, candidateId },
      }),
      JSON.stringify({ error: { message: 'transient ingest failure' } }),
      now,
      now,
      '2026-07-14T01:10:00.000Z',
    );
    context.sqlite.prepare(`
      INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at)
      VALUES (?, 'writer-page', 'page-a', '{"content":"checkpoint"}', ?)
    `).run(ingestJobId, now);
    context.sqlite.prepare(`
      UPDATE research_candidate_ingests
      SET status = 'queued', source_id = 'source-child-retry', ingest_job_id = ?
      WHERE approval_id = ? AND candidate_id = ?
    `).run(ingestJobId, approvalId, candidateId);
    expect(context.repo.failResearchDeliveryFromJob(
      approvalId,
      candidateId,
      ingestJobId,
      { code: 'RESEARCH_INGEST_FAILED', message: 'transient ingest failure' },
      new Date('2026-07-14T01:10:00.000Z'),
    )).toBe(true);
    expect(context.repo.finalizeTopicResearchRunAtomic(
      stored.run.id,
      new Date('2026-07-14T01:10:01.000Z'),
    )).toBe(true);
    return { ...context, runId: stored.run.id, approvalId, candidateId, ingestJobId };
  }

  it('原位恢复 failed child job、delivery 与 run，并保留 checkpoint/attempt 历史', async () => {
    const context = await createFailedChildTopicRun();
    const before = context.repo.findResearchRunById(context.runId, 's1')!;
    expect(before.run.status).toBe('failed');
    expect(before.deliveries[0]).toMatchObject({ status: 'failed', attemptCount: 0 });

    const retried = context.repo.retryResearchIngestJobAtomic({
      runId: context.runId,
      subjectId: 's1',
      approvalId: context.approvalId,
      candidateId: context.candidateId,
      ingestJobId: context.ingestJobId,
      now: new Date('2026-07-14T02:00:00.000Z'),
    });

    expect(retried.run).toMatchObject({
      status: 'importing',
      version: before.run.version + 1,
      completedAt: null,
      errorJson: null,
    });
    expect(retried.deliveries[0]).toMatchObject({
      status: 'queued',
      sourceId: 'source-child-retry',
      ingestJobId: context.ingestJobId,
      completedAt: null,
      errorJson: null,
    });
    expect(context.sqlite.prepare(`
      SELECT status, result_json, completed_at, attempt_count, cancel_requested
      FROM jobs WHERE id = ?
    `).get(context.ingestJobId)).toEqual({
      status: 'pending',
      result_json: null,
      completed_at: null,
      attempt_count: 2,
      cancel_requested: 0,
    });
    expect(context.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM ingest_checkpoints WHERE job_id = ?
    `).get(context.ingestJobId)).toEqual({ count: 1 });
  });

  it('手动终结的 Research child job 不可恢复，事务不改变 run/delivery', async () => {
    const context = await createFailedChildTopicRun();
    context.sqlite.prepare(`
      UPDATE jobs SET cancel_requested = 1, result_json = ? WHERE id = ?
    `).run(JSON.stringify({ cancelled: true }), context.ingestJobId);
    const before = context.repo.findResearchRunById(context.runId, 's1')!;

    expect(() => context.repo.retryResearchIngestJobAtomic({
      runId: context.runId,
      subjectId: 's1',
      approvalId: context.approvalId,
      candidateId: context.candidateId,
      ingestJobId: context.ingestJobId,
    })).toThrow(/not retryable/);

    const after = context.repo.findResearchRunById(context.runId, 's1')!;
    expect(after.run).toMatchObject({ status: before.run.status, version: before.run.version });
    expect(after.deliveries[0]).toMatchObject({ status: 'failed' });
    expect(context.sqlite.prepare('SELECT status FROM jobs WHERE id = ?')
      .get(context.ingestJobId)).toEqual({ status: 'failed' });
  });

  it('重置 failed delivery、换发 coordinator 并把 run CAS 回 importing', async () => {
    const { repo, sqlite, runId, approvalId, candidateId } = await createFailedTopicRun();
    const before = repo.findResearchRunById(runId, 's1')!;
    expect(before.run.status).toBe('failed');
    const previousCoordinator = before.approval!.coordinatorJobId;

    const result = repo.retryResearchRunImportAtomic({
      runId,
      subjectId: 's1',
      expectedVersion: before.run.version,
      now: new Date('2026-07-14T02:00:00.000Z'),
    });

    expect(result.stored.run.status).toBe('importing');
    expect(result.stored.run.version).toBe(before.run.version + 1);
    expect(result.stored.run.completedAt).toBeNull();
    expect(result.stored.run.errorJson).toBeNull();
    expect(result.coordinatorJobId).not.toBe(previousCoordinator);
    expect(result.stored.approval!.coordinatorJobId).toBe(result.coordinatorJobId);

    const delivery = result.stored.deliveries.find(
      (row) => row.approvalId === approvalId && row.candidateId === candidateId,
    )!;
    expect(delivery).toMatchObject({
      status: 'pending',
      ingestJobId: null,
      claimToken: null,
      completedAt: null,
      errorJson: null,
      attemptCount: 1,
    });

    const job = sqlite.prepare('SELECT type, status, subject_id, params_json FROM jobs WHERE id = ?')
      .get(result.coordinatorJobId) as { type: string; status: string; subject_id: string; params_json: string };
    expect(job).toMatchObject({ type: 'research-import', status: 'pending', subject_id: 's1' });
    expect(JSON.parse(job.params_json)).toEqual({
      approvalId,
      runId,
      subjectId: 's1',
    });

    // 重试后的 delivery 可被新 coordinator 重新 claim。
    const reclaimed = repo.claimResearchDelivery({
      approvalId,
      candidateId,
      now: new Date('2026-07-14T02:00:01.000Z'),
      leaseMs: 30_000,
    });
    expect(reclaimed).toMatchObject({ status: 'fetching', attemptCount: 2 });
  });

  it('版本陈旧、状态不可重试或 verification 后失败均拒绝', async () => {
    const { repo, sqlite, runId } = await createFailedTopicRun();
    const before = repo.findResearchRunById(runId, 's1')!;

    expect(() => repo.retryResearchRunImportAtomic({
      runId,
      subjectId: 's1',
      expectedVersion: before.run.version + 5,
    })).toThrow(/stale/);
    expect(() => repo.retryResearchRunImportAtomic({
      runId: 'missing',
      subjectId: 's1',
      expectedVersion: 1,
    })).toThrow(/not found/);
    expect(() => repo.retryResearchRunImportAtomic({
      runId,
      subjectId: 's2',
      expectedVersion: before.run.version,
    })).toThrow(/not found|subject/i);

    sqlite.prepare("UPDATE research_runs SET verification_lint_job_id = 'lint-x' WHERE id = ?").run(runId);
    expect(() => repo.retryResearchRunImportAtomic({
      runId,
      subjectId: 's1',
      expectedVersion: before.run.version,
    })).toThrow(/verification/);
    sqlite.prepare('UPDATE research_runs SET verification_lint_job_id = NULL WHERE id = ?').run(runId);

    sqlite.prepare(`
      INSERT INTO research_run_findings (
        run_id, finding_id, snapshot_json, verification_status, verified_at
      ) VALUES (?, 'finding-direct', '{}', 'unverifiable', ?)
    `).run(runId, '2026-07-14T01:30:00.000Z');
    expect(() => repo.retryResearchRunImportAtomic({
      runId,
      subjectId: 's1',
      expectedVersion: before.run.version,
    })).toThrow(/verification/);
    sqlite.prepare('DELETE FROM research_run_findings WHERE run_id = ?').run(runId);

    // 成功重试后 run 进入 importing，重复重试被状态拒绝。
    repo.retryResearchRunImportAtomic({
      runId,
      subjectId: 's1',
      expectedVersion: before.run.version,
    });
    expect(() => repo.retryResearchRunImportAtomic({
      runId,
      subjectId: 's1',
      expectedVersion: before.run.version + 1,
    })).toThrow(/not in a retryable state/);
  });
});
