import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '@/lib/contracts';
import type { OperationRow } from '../../db/repos/operations-repo';

let dir: string;
let previousDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'research-reconciler-'));
  previousDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDb;
  rmSync(dir, { recursive: true, force: true });
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'ingest-1',
    type: 'ingest',
    status: 'completed',
    subjectId: 'subject-1',
    paramsJson: '{}',
    resultJson: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    startedAt: '2026-07-14T00:00:01.000Z',
    completedAt: '2026-07-14T00:01:00.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 1,
    ...overrides,
  };
}

function operation(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: 'op-1',
    jobId: 'ingest-1',
    subjectId: 'subject-1',
    preHead: 'pre',
    postHead: 'post',
    changesetJson: JSON.stringify([
      { action: 'create', path: 'wiki/general/fallback.md', content: '# Fallback' },
    ]),
    status: 'applied',
    jobType: 'ingest',
    ...overrides,
  };
}

describe('materializeIngestProvenance', () => {
  it('优先使用 Ingest result，去重排序并标识系统页，同时保留 operation/commit', async () => {
    const reconciler = await import('../research-provenance-reconciler');
    const result = reconciler.materializeIngestProvenance(
      job({
        resultJson: JSON.stringify({
          pagesCreated: ['zeta', 'index', 'zeta'],
          pagesUpdated: ['alpha', 'zeta'],
          commitSha: 'result-head',
        }),
      }),
      { id: 'subject-1', slug: 'general' },
      [operation({ id: 'op-b', postHead: 'operation-head' }), operation({ id: 'op-a' })],
      new Set(['subject-1:index']),
    );

    expect(result).toEqual({
      operationIds: ['op-a', 'op-b'],
      touchedPages: [
        { slug: 'alpha', action: 'updated', system: false },
        { slug: 'index', action: 'created', system: true },
        { slug: 'zeta', action: 'created', system: false },
      ],
      commitSha: 'result-head',
    });
  });

  it('result 损坏或缺失时回退 applied operations', async () => {
    const reconciler = await import('../research-provenance-reconciler');
    const result = reconciler.materializeIngestProvenance(
      job({ resultJson: '{' }),
      { id: 'subject-1', slug: 'general' },
      [
        operation({
          id: 'op-2',
          postHead: 'head-2',
          changesetJson: JSON.stringify([
            { action: 'update', path: 'wiki/general/beta.md', content: '# Beta' },
            { action: 'create', path: 'wiki/general/index.md', content: '# Index' },
          ]),
        }),
      ],
      new Set(['subject-1:index']),
    );

    expect(result).toEqual({
      operationIds: ['op-2'],
      touchedPages: [
        { slug: 'beta', action: 'updated', system: false },
        { slug: 'index', action: 'created', system: true },
      ],
      commitSha: 'head-2',
    });
  });
});

async function setupRun(origin: 'topic' | 'findings') {
  const subjectsRepo = await import('../../db/repos/subjects-repo');
  const provenance = await import('../research-provenance');
  const findingIdentity = await import('../finding-identity');
  const repo = await import('../../db/repos/research-provenance-repo');
  const { getRawDb } = await import('../../db/client');
  const subject = subjectsRepo.getBySlug('general')!;
  const finding = {
    type: 'coverage-gap' as const,
    severity: 'info' as const,
    pageSlug: 'distributed-systems',
    description: 'Needs stronger sources',
    suggestedFix: null,
    subjectSlug: subject.slug,
  };
  const originalFindingId = findingIdentity.findingId({ ...finding, subjectId: subject.id });
  const persisted = repo.persistResearchRun({
    subjectId: subject.id,
    researchJobId: `research-${origin}`,
    origin,
    lintJobId: origin === 'findings' ? 'lint-original' : null,
    topic: origin === 'topic' ? 'distributed systems' : null,
    topics: ['distributed systems'],
    queries: ['distributed systems sources'],
    findings: origin === 'findings'
      ? [{ findingId: originalFindingId, snapshot: finding }]
      : [],
    candidates: provenance.prepareResearchCandidates([
      { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: null },
    ]),
  });
  const approved = repo.approveResearchRunAtomic({
    runId: persisted.run.id,
    subjectId: subject.id,
    candidateIds: [persisted.candidates[0]!.id],
    expectedVersion: 1,
    idempotencyKey: `approve-${origin}`,
  });
  const sqlite = getRawDb();
  const childJobId = `ingest-${origin}`;
  const now = '2026-07-14T01:00:00.000Z';
  sqlite.prepare(`
    INSERT INTO jobs (
      id, type, status, subject_id, params_json, result_json, created_at,
      started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count
    ) VALUES (?, 'ingest', 'completed', ?, ?, ?, ?, ?, ?, NULL, NULL, 1)
  `).run(
    childJobId,
    subject.id,
    JSON.stringify({
      sourceId: 'source-1',
      filename: 'a.html',
      subjectId: subject.id,
      researchProvenance: {
        runId: persisted.run.id,
        approvalId: approved.stored.approval!.id,
        candidateId: persisted.candidates[0]!.id,
      },
    }),
    JSON.stringify({
      pagesCreated: ['distributed-systems', 'index'],
      pagesUpdated: [],
      linksAdded: 0,
      commitSha: 'commit-1',
    }),
    now,
    now,
    now,
  );
  sqlite.prepare(`
    UPDATE research_candidate_ingests
    SET status = 'queued', source_id = 'source-1', ingest_job_id = ?
    WHERE run_id = ?
  `).run(childJobId, persisted.run.id);
  return {
    subject,
    repo,
    sqlite,
    runId: persisted.run.id,
    childJobId,
    originalFindingId,
    finding,
  };
}

describe('Research provenance 终态对账', () => {
  it('topic run 物化 completed delivery 并直接聚合 completed', async () => {
    const context = await setupRun('topic');
    const reconciler = await import('../research-provenance-reconciler');

    reconciler.reconcileResearchRun(context.runId);

    const stored = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    expect(stored.run.status).toBe('completed');
    expect(stored.deliveries[0]).toMatchObject({
      status: 'completed',
      sourceId: 'source-1',
      operationIdsJson: '[]',
      commitSha: 'commit-1',
    });
    expect(JSON.parse(stored.deliveries[0]!.touchedPagesJson)).toEqual([
      { slug: 'distributed-systems', action: 'created', system: false },
      { slug: 'index', action: 'created', system: false },
    ]);
  });

  it('child job running/failed 状态同步到 delivery，并聚合 topic failed', async () => {
    const context = await setupRun('topic');
    const reconciler = await import('../research-provenance-reconciler');
    context.sqlite.prepare(`
      UPDATE jobs SET status = 'running', result_json = NULL, completed_at = NULL
      WHERE id = ?
    `).run(context.childJobId);

    reconciler.reconcileResearchRun(context.runId);
    expect(context.repo.findResearchRunById(context.runId, context.subject.id)!.deliveries[0])
      .toMatchObject({ status: 'running' });

    context.sqlite.prepare(`
      UPDATE jobs SET status = 'failed', result_json = ?, completed_at = ? WHERE id = ?
    `).run(
      JSON.stringify({ error: { message: 'ingest failed' } }),
      '2026-07-14T02:00:00.000Z',
      context.childJobId,
    );
    reconciler.reconcileResearchRun(context.runId);

    const terminal = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    expect(terminal.deliveries[0]).toMatchObject({ status: 'failed' });
    expect(terminal.run.status).toBe('failed');
  });

  it('finding run 全部 delivery 终态后只创建一个 verification lint', async () => {
    const context = await setupRun('findings');
    const reconciler = await import('../research-provenance-reconciler');

    reconciler.reconcileResearchRun(context.runId);
    reconciler.reconcileResearchRun(context.runId);

    const stored = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    expect(stored.run.status).toBe('verifying');
    expect(stored.run.verificationLintJobId).toBeTruthy();
    expect(context.sqlite.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'lint'").get())
      .toEqual({ count: 1 });
    const lint = context.sqlite.prepare('SELECT params_json FROM jobs WHERE id = ?')
      .get(stored.run.verificationLintJobId!) as { params_json: string };
    expect(JSON.parse(lint.params_json)).toEqual({
      subjectId: context.subject.id,
      researchVerification: { runId: context.runId },
    });
  });

  it('verification lint 用稳定 locus 保守识别 residual，并聚合 partial', async () => {
    const context = await setupRun('findings');
    const reconciler = await import('../research-provenance-reconciler');
    reconciler.reconcileResearchRun(context.runId);
    const verifying = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    const changed = {
      ...context.finding,
      id: 'ignored-by-parser',
      subjectId: context.subject.id,
      description: 'Description changed but locus is stable',
    };
    context.sqlite.prepare(`
      UPDATE jobs SET status = 'completed', result_json = ?, completed_at = ? WHERE id = ?
    `).run(
      JSON.stringify({ findings: [changed] }),
      '2026-07-14T02:00:00.000Z',
      verifying.run.verificationLintJobId,
    );

    reconciler.reconcileResearchRun(context.runId);

    const terminal = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    expect(terminal.run.status).toBe('partial');
    expect(terminal.findings[0]).toMatchObject({ verificationStatus: 'residual' });
    expect(JSON.parse(terminal.findings[0]!.verificationSnapshotJson!)).toMatchObject({
      description: 'Description changed but locus is stable',
    });
  });

  it('verification lint 中原 finding 消失时物化 fixed，并聚合 completed', async () => {
    const context = await setupRun('findings');
    const reconciler = await import('../research-provenance-reconciler');
    reconciler.reconcileResearchRun(context.runId);
    const verifying = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    context.sqlite.prepare(`
      UPDATE jobs SET status = 'completed', result_json = ?, completed_at = ? WHERE id = ?
    `).run(
      JSON.stringify({ findings: [] }),
      '2026-07-14T02:00:00.000Z',
      verifying.run.verificationLintJobId,
    );

    reconciler.reconcileResearchRun(context.runId);

    const terminal = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    expect(terminal.run.status).toBe('completed');
    expect(terminal.findings[0]).toMatchObject({
      verificationStatus: 'fixed',
      verificationSnapshotJson: null,
    });
  });

  it('verification lint 失败时 finding 标记 unverifiable，run 聚合 failed', async () => {
    const context = await setupRun('findings');
    const reconciler = await import('../research-provenance-reconciler');
    reconciler.reconcileResearchRun(context.runId);
    const verifying = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    context.sqlite.prepare(`
      UPDATE jobs SET status = 'failed', result_json = ?, completed_at = ? WHERE id = ?
    `).run(
      JSON.stringify({ error: { message: 'lint failed' } }),
      '2026-07-14T02:00:00.000Z',
      verifying.run.verificationLintJobId,
    );

    reconciler.reconcileResearchRun(context.runId);

    const terminal = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    expect(terminal.run.status).toBe('failed');
    expect(terminal.findings[0]).toMatchObject({ verificationStatus: 'unverifiable' });
  });

  it('terminal coordinator 将未调度 pending/fetching delivery 终结为 failed', async () => {
    const context = await setupRun('topic');
    const stored = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    context.sqlite.prepare('DELETE FROM jobs WHERE id = ?').run(context.childJobId);
    context.sqlite.prepare(`
      UPDATE research_candidate_ingests
      SET status = 'fetching', source_id = NULL, ingest_job_id = NULL,
          claim_token = 'claim', lease_expires_at = '2099-01-01T00:00:00.000Z'
      WHERE run_id = ?
    `).run(context.runId);
    context.sqlite.prepare(`
      UPDATE jobs SET status = 'failed', completed_at = ?, result_json = ? WHERE id = ?
    `).run(
      '2026-07-14T02:00:00.000Z',
      JSON.stringify({ error: { message: 'coordinator failed' } }),
      stored.approval!.coordinatorJobId,
    );
    const reconciler = await import('../research-provenance-reconciler');

    reconciler.reconcileResearchRun(context.runId);

    const terminal = context.repo.findResearchRunById(context.runId, context.subject.id)!;
    expect(terminal.deliveries[0]).toMatchObject({ status: 'failed', claimToken: null });
    expect(terminal.run.status).toBe('failed');
  });
});
