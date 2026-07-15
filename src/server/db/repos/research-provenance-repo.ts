import { randomUUID } from 'node:crypto';
import type {
  Job,
  ResearchApprovalRow,
  ResearchCandidateIngestRow,
  ResearchCandidateRow,
  ResearchFindingVerificationStatus,
  ResearchRunFindingRow,
  ResearchRunOrigin,
  ResearchRunRow,
  SubjectId,
} from '@/lib/contracts';
import { getRawDb } from '../client';
import {
  canonicalizeResearchSelection,
  parseResearchFindingSnapshot,
  researchApprovalPayloadHash,
  researchCandidateId,
  researchCandidateSetHash,
  validateStoredResearchCandidates,
  type PreparedResearchCandidate,
  type ResearchFindingSnapshot,
} from '../../services/research-provenance';
import { findingId } from '../../services/finding-identity';

export type ResearchProvenanceRepoErrorCode =
  | 'candidate-set-conflict'
  | 'run-subject-conflict'
  | 'run-not-found'
  | 'run-stale'
  | 'already-approved'
  | 'idempotency-conflict'
  | 'selection-invalid'
  | 'run-not-approvable'
  | 'run-not-retryable';

/** Research repo 可映射为稳定 API 语义的冲突。 */
export class ResearchProvenanceRepoError extends Error {
  constructor(
    readonly code: ResearchProvenanceRepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ResearchProvenanceRepoError';
  }
}

export interface ResearchFindingInput {
  findingId: string;
  snapshot: ResearchFindingSnapshot;
}

export interface PersistResearchRunInput {
  subjectId: SubjectId;
  researchJobId: string;
  origin: ResearchRunOrigin;
  lintJobId: string | null;
  topic: string | null;
  topics: string[];
  queries: string[];
  findings: ResearchFindingInput[];
  candidates: PreparedResearchCandidate[];
}

export interface StoredResearchRun {
  run: ResearchRunRow;
  findings: ResearchRunFindingRow[];
  candidates: ResearchCandidateRow[];
  approval: ResearchApprovalRow | null;
  deliveries: ResearchCandidateIngestRow[];
}

export interface ApproveResearchRunInput {
  runId: string;
  subjectId: SubjectId;
  candidateIds: string[];
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ApproveResearchRunResult {
  stored: StoredResearchRun;
  coordinatorJobId: string;
  replayed: boolean;
}

export interface ClaimResearchDeliveryInput {
  approvalId: string;
  candidateId: string;
  now?: Date;
  leaseMs?: number;
}

export interface ResearchDeliveryClaimInput extends ClaimResearchDeliveryInput {
  claimToken: string;
}

export interface FailResearchDeliveryClaimInput extends ResearchDeliveryClaimInput {
  error: { code?: string; message: string };
}

export interface MarkResearchDeliveryQueuedInput extends ResearchDeliveryClaimInput {
  sourceId: string;
  ingestJobId: string;
}

export interface CompleteResearchDeliveryInput {
  approvalId: string;
  candidateId: string;
  ingestJobId: string;
  sourceId: string;
  operationIds: string[];
  touchedPages: unknown[];
  commitSha: string | null;
  now?: Date;
}

export interface ResearchFindingVerificationOutcome {
  findingId: string;
  status: Exclude<ResearchFindingVerificationStatus, 'pending'>;
  snapshot: unknown | null;
}

export interface EnqueueResearchDeliveryFromSourceInput extends ResearchDeliveryClaimInput {
  runId: string;
  subjectId: SubjectId;
  sourceId: string;
}

type RawDb = ReturnType<typeof getRawDb>;
type RawRow = Record<string, unknown>;

/** researchJobId 是 worker retry 的幂等边界；命中时不再重复模型或搜索调用。 */
export function findResearchRunByJobId(
  researchJobId: string,
  subjectId?: SubjectId,
): StoredResearchRun | null {
  const sqlite = getRawDb();
  const read = sqlite.transaction((): StoredResearchRun | null => {
    const row = subjectId === undefined
      ? sqlite.prepare('SELECT * FROM research_runs WHERE research_job_id = ?').get(researchJobId)
      : sqlite.prepare('SELECT * FROM research_runs WHERE research_job_id = ? AND subject_id = ?')
        .get(researchJobId, subjectId);
    return row ? hydrateResearchRun(sqlite, row as RawRow) : null;
  });
  return read.deferred();
}

export function findResearchRunById(
  runId: string,
  subjectId?: SubjectId,
): StoredResearchRun | null {
  const sqlite = getRawDb();
  const read = sqlite.transaction(
    (): StoredResearchRun | null => findResearchRunByIdRaw(sqlite, runId, subjectId),
  );
  return read.deferred();
}

/** 同一 read snapshot 内按 researchJobId 批量恢复，供 Health/backlog 避免 N 次撕裂读取。 */
export function findResearchRunsByJobIds(
  researchJobIds: string[],
  subjectId: SubjectId,
): StoredResearchRun[] {
  const ids = [...new Set(researchJobIds.filter(Boolean))];
  if (ids.length === 0) return [];
  if (ids.length > 200) throw new Error('Research run batch lookup accepts at most 200 job IDs');
  const sqlite = getRawDb();
  const placeholders = ids.map(() => '?').join(', ');
  const read = sqlite.transaction((): StoredResearchRun[] => {
    const rows = sqlite.prepare(`
      SELECT * FROM research_runs
      WHERE subject_id = ? AND research_job_id IN (${placeholders})
    `).all(subjectId, ...ids) as RawRow[];
    const byJobId = new Map(
      rows.map((row) => [String(row.research_job_id), hydrateResearchRun(sqlite, row)]),
    );
    return ids.flatMap((id) => {
      const stored = byJobId.get(id);
      return stored ? [stored] : [];
    });
  });
  return read.deferred();
}

/** 在一个 IMMEDIATE transaction 内原子创建 run、finding 与 candidate 快照。 */
export function persistResearchRun(input: PersistResearchRunInput): StoredResearchRun {
  validateRunInput(input);
  const candidateSetHash = researchCandidateSetHash(input.candidates);
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): StoredResearchRun => {
    const subject = sqlite.prepare('SELECT slug FROM subjects WHERE id = ?')
      .get(input.subjectId) as { slug: string } | undefined;
    if (!subject) throw new Error(`Research subject not found: ${input.subjectId}`);
    if (input.findings.some((finding) => finding.snapshot.subjectSlug !== subject.slug)) {
      throw new ResearchProvenanceRepoError(
        'run-subject-conflict',
        'Research finding snapshot belongs to another subject',
      );
    }
    const existingRow = sqlite.prepare(
      'SELECT * FROM research_runs WHERE research_job_id = ?',
    ).get(input.researchJobId) as RawRow | undefined;
    if (existingRow) {
      const existing = researchRunRow(existingRow);
      if (existing.subjectId !== input.subjectId) {
        throw new ResearchProvenanceRepoError(
          'run-subject-conflict',
          'Research job is already bound to another subject',
        );
      }
      if (existing.candidateSetHash !== candidateSetHash) {
        throw new ResearchProvenanceRepoError(
          'candidate-set-conflict',
          'Research retry produced a different candidate set',
        );
      }
      return hydrateResearchRun(sqlite, existingRow);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const status = input.candidates.length === 0 ? 'empty' : 'awaiting-approval';
    sqlite.prepare(`
      INSERT INTO research_runs (
        id, subject_id, research_job_id, origin, lint_job_id, topic,
        topics_json, queries_json, candidate_set_hash, status, version,
        verification_lint_job_id, created_at, updated_at, completed_at, error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, NULL)
    `).run(
      id,
      input.subjectId,
      input.researchJobId,
      input.origin,
      input.lintJobId,
      input.topic,
      JSON.stringify(input.topics),
      JSON.stringify(input.queries),
      candidateSetHash,
      status,
      now,
      now,
      status === 'empty' ? now : null,
    );

    const insertFinding = sqlite.prepare(`
      INSERT INTO research_run_findings (
        run_id, finding_id, snapshot_json, verification_status,
        verified_at, verification_snapshot_json
      ) VALUES (?, ?, ?, 'pending', NULL, NULL)
    `);
    for (const finding of input.findings) {
      insertFinding.run(id, finding.findingId, JSON.stringify(finding.snapshot));
    }

    const insertCandidate = sqlite.prepare(`
      INSERT INTO research_candidates (
        id, run_id, normalized_url, snapshot_json, rank,
        decision, approval_id, decided_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL)
    `);
    for (const candidate of input.candidates) {
      insertCandidate.run(
        researchCandidateId(id, candidate.normalizedUrl),
        id,
        candidate.normalizedUrl,
        JSON.stringify(candidate.snapshot),
        candidate.rank,
      );
    }

    const created = findResearchRunByIdRaw(sqlite, id, input.subjectId);
    if (!created) throw new Error('Failed to reload persisted Research run');
    return created;
  });
  return transaction.immediate();
}

/**
 * approval、candidate decisions、deliveries 与 research-import job 必须共用此事务，
 * 禁止在这里调用普通 queue.enqueue。
 */
export function approveResearchRunAtomic(
  input: ApproveResearchRunInput,
): ApproveResearchRunResult {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ResearchProvenanceRepoError(
      'run-stale',
      'Research approval expectedVersion must be a positive integer',
    );
  }
  const selection = canonicalizeResearchSelection(input.candidateIds);
  const payloadHash = researchApprovalPayloadHash(
    input.runId,
    input.expectedVersion,
    selection,
  );
  if (!input.idempotencyKey.trim()) {
    throw new ResearchProvenanceRepoError(
      'idempotency-conflict',
      'Research approval idempotency key must not be empty',
    );
  }

  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): ApproveResearchRunResult => {
    // 幂等重放必须先于当前 version/status；同时用 subject join 保持租户隔离。
    const existingApprovalRaw = sqlite.prepare(`
      SELECT a.* FROM research_approvals a
      JOIN research_runs r ON r.id = a.run_id
      WHERE a.run_id = ? AND a.idempotency_key = ? AND r.subject_id = ?
    `).get(input.runId, input.idempotencyKey, input.subjectId) as RawRow | undefined;
    if (existingApprovalRaw) {
      const existingApproval = researchApprovalRow(existingApprovalRaw);
      if (existingApproval.payloadHash !== payloadHash) {
        throw new ResearchProvenanceRepoError(
          'idempotency-conflict',
          'Research approval idempotency key was reused with a different payload',
        );
      }
      const persistedSelection = parsePersistedSelection(
        existingApproval.selectedCandidateIdsJson,
      );
      if (!sameStringArray(persistedSelection, selection)) {
        throw new Error('Persisted Research approval selection is inconsistent with its payload hash');
      }
      const stored = findResearchRunByIdRaw(sqlite, input.runId, input.subjectId);
      if (!stored) throw new ResearchProvenanceRepoError('run-not-found', 'Research run not found');
      validateStoredResearchCandidates(
        stored.run.id,
        stored.run.candidateSetHash,
        stored.candidates,
      );
      return {
        stored,
        coordinatorJobId: existingApproval.coordinatorJobId,
        replayed: true,
      };
    }

    const stored = findResearchRunByIdRaw(sqlite, input.runId, input.subjectId);
    if (!stored) {
      throw new ResearchProvenanceRepoError('run-not-found', 'Research run not found');
    }
    validateStoredResearchCandidates(
      stored.run.id,
      stored.run.candidateSetHash,
      stored.candidates,
    );
    if (stored.approval) {
      throw new ResearchProvenanceRepoError(
        'already-approved',
        'Research run already has an immutable approval',
      );
    }
    if (stored.run.status !== 'awaiting-approval') {
      throw new ResearchProvenanceRepoError(
        'run-not-approvable',
        `Research run is not awaiting approval: ${stored.run.status}`,
      );
    }
    if (stored.run.version !== input.expectedVersion) {
      throw new ResearchProvenanceRepoError(
        'run-stale',
        'Research run version is stale',
      );
    }

    const candidatesById = new Map(stored.candidates.map((candidate) => [candidate.id, candidate]));
    if (selection.some((candidateId) => !candidatesById.has(candidateId))) {
      throw new ResearchProvenanceRepoError(
        'selection-invalid',
        'Research approval selection contains a candidate outside this run',
      );
    }

    const approvalId = randomUUID();
    const coordinatorJobId = randomUUID();
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO research_approvals (
        id, run_id, selected_candidate_ids_json, payload_hash,
        idempotency_key, coordinator_job_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      approvalId,
      input.runId,
      JSON.stringify(selection),
      payloadHash,
      input.idempotencyKey,
      coordinatorJobId,
      now,
    );

    const selected = new Set(selection);
    const decideCandidate = sqlite.prepare(`
      UPDATE research_candidates
      SET decision = ?, approval_id = ?, decided_at = ?
      WHERE id = ? AND run_id = ? AND decision = 'pending'
    `);
    const insertDelivery = sqlite.prepare(`
      INSERT INTO research_candidate_ingests (
        approval_id, candidate_id, run_id, normalized_url, status,
        source_id, ingest_job_id, operation_ids_json, touched_pages_json,
        commit_sha, claim_token, lease_expires_at, attempt_count,
        created_at, updated_at, completed_at, error_json
      ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, '[]', '[]',
        NULL, NULL, NULL, 0, ?, ?, NULL, NULL)
    `);
    for (const candidate of stored.candidates) {
      const isSelected = selected.has(candidate.id);
      const update = decideCandidate.run(
        isSelected ? 'approved' : 'rejected',
        approvalId,
        now,
        candidate.id,
        input.runId,
      );
      if (update.changes !== 1) {
        throw new ResearchProvenanceRepoError(
          'already-approved',
          'Research candidate decision was already claimed',
        );
      }
      if (isSelected) {
        insertDelivery.run(
          approvalId,
          candidate.id,
          input.runId,
          candidate.normalizedUrl,
          now,
          now,
        );
      }
    }

    const coordinatorParams = {
      approvalId,
      runId: input.runId,
      subjectId: input.subjectId,
    };
    sqlite.prepare(`
      INSERT INTO jobs (
        id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count
      ) VALUES (?, 'research-import', 'pending', ?, ?, NULL, ?,
        NULL, NULL, NULL, NULL, 0)
    `).run(coordinatorJobId, input.subjectId, JSON.stringify(coordinatorParams), now);

    const runUpdate = sqlite.prepare(`
      UPDATE research_runs
      SET status = 'importing', version = version + 1, updated_at = ?
      WHERE id = ? AND subject_id = ? AND status = 'awaiting-approval' AND version = ?
    `).run(now, input.runId, input.subjectId, input.expectedVersion);
    if (runUpdate.changes !== 1) {
      throw new ResearchProvenanceRepoError('run-stale', 'Research run version changed concurrently');
    }

    const approved = findResearchRunByIdRaw(sqlite, input.runId, input.subjectId);
    if (!approved) throw new Error('Failed to reload approved Research run');
    return { stored: approved, coordinatorJobId, replayed: false };
  });
  return transaction.immediate();
}

/** pending 或租约已过期的 fetching delivery 才能获得新 claim。 */
export function claimResearchDelivery(
  input: ClaimResearchDeliveryInput,
): ResearchCandidateIngestRow | null {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 60_000;
  assertLeaseDuration(leaseMs);
  const nowIso = now.toISOString();
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): ResearchCandidateIngestRow | null => {
    const update = sqlite.prepare(`
      UPDATE research_candidate_ingests
      SET status = 'fetching', claim_token = ?, lease_expires_at = ?,
          attempt_count = attempt_count + 1, updated_at = ?, error_json = NULL
      WHERE approval_id = ? AND candidate_id = ?
        AND (
          status = 'pending'
          OR (status = 'fetching' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
    `).run(
      claimToken,
      leaseExpiresAt,
      nowIso,
      input.approvalId,
      input.candidateId,
      nowIso,
    );
    if (update.changes !== 1) return null;
    const row = sqlite.prepare(`
      SELECT * FROM research_candidate_ingests
      WHERE approval_id = ? AND candidate_id = ?
    `).get(input.approvalId, input.candidateId) as RawRow | undefined;
    if (!row) throw new Error('Claimed Research delivery disappeared');
    return researchCandidateIngestRow(row);
  });
  return transaction.immediate();
}

/** 仅当前且未过期的 claim 可以续租。 */
export function renewResearchDeliveryClaim(input: ResearchDeliveryClaimInput): boolean {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 60_000;
  assertLeaseDuration(leaseMs);
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = getRawDb().prepare(`
    UPDATE research_candidate_ingests
    SET lease_expires_at = ?, updated_at = ?
    WHERE approval_id = ? AND candidate_id = ?
      AND status = 'fetching' AND claim_token = ?
      AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
  `).run(
    leaseExpiresAt,
    nowIso,
    input.approvalId,
    input.candidateId,
    input.claimToken,
    nowIso,
  );
  return result.changes === 1;
}

/** source 写事务开始前复验 claim，避免已失效请求创建文件或 child job。 */
export function assertResearchDeliveryClaimInTransaction(
  sqlite: RawDb,
  input: ResearchDeliveryClaimInput,
): void {
  const nowIso = (input.now ?? new Date()).toISOString();
  const row = sqlite.prepare(`
    SELECT 1 FROM research_candidate_ingests
    WHERE approval_id = ? AND candidate_id = ?
      AND status = 'fetching' AND claim_token = ?
      AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
      AND source_id IS NULL AND ingest_job_id IS NULL
  `).get(
    input.approvalId,
    input.candidateId,
    input.claimToken,
    nowIso,
  );
  if (!row) throw new Error('Research delivery claim is stale or no longer writable');
}

/** 抓取失败只允许由当前 claim 终结，迟到请求不得覆盖新 attempt。 */
export function failResearchDeliveryClaim(input: FailResearchDeliveryClaimInput): boolean {
  const nowIso = (input.now ?? new Date()).toISOString();
  const result = getRawDb().prepare(`
    UPDATE research_candidate_ingests
    SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
        updated_at = ?, completed_at = ?, error_json = ?
    WHERE approval_id = ? AND candidate_id = ?
      AND status = 'fetching' AND claim_token = ?
      AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
  `).run(
    nowIso,
    nowIso,
    JSON.stringify(input.error),
    input.approvalId,
    input.candidateId,
    input.claimToken,
    nowIso,
  );
  return result.changes === 1;
}

/**
 * 供 source 持久化事务调用：source、child job 与 delivery queued 必须同成同败。
 * 调用方必须传入当前 transaction 使用的同一 SQLite 连接。
 */
export function markResearchDeliveryQueuedInTransaction(
  sqlite: RawDb,
  input: MarkResearchDeliveryQueuedInput,
): void {
  const nowIso = (input.now ?? new Date()).toISOString();
  const result = sqlite.prepare(`
    UPDATE research_candidate_ingests
    SET status = 'queued', source_id = ?, ingest_job_id = ?,
        claim_token = NULL, lease_expires_at = NULL, updated_at = ?, error_json = NULL
    WHERE approval_id = ? AND candidate_id = ?
      AND status = 'fetching' AND claim_token = ?
      AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
      AND (source_id IS NULL OR source_id = ?) AND ingest_job_id IS NULL
  `).run(
    input.sourceId,
    input.ingestJobId,
    nowIso,
    input.approvalId,
    input.candidateId,
    input.claimToken,
    nowIso,
    input.sourceId,
  );
  if (result.changes !== 1) {
    throw new Error('Research delivery claim is stale or no longer writable');
  }
}

/**
 * 崩溃恢复分支：delivery 已有 canonical source 但缺 child job 时，不再联网或重写文件，
 * 在同一事务内复验 claim、创建 Ingest job 并推进 queued。
 */
export function enqueueResearchDeliveryFromSourceAtomic(
  input: EnqueueResearchDeliveryFromSourceInput,
): Job {
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): Job => {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const source = sqlite.prepare(`
      SELECT filename FROM sources WHERE id = ? AND subject_id = ?
    `).get(input.sourceId, input.subjectId) as { filename: string } | undefined;
    if (!source) throw new Error('Research delivery source is unavailable');
    const claim = sqlite.prepare(`
      SELECT 1 FROM research_candidate_ingests
      WHERE approval_id = ? AND candidate_id = ? AND run_id = ?
        AND status = 'fetching' AND claim_token = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
        AND source_id = ? AND ingest_job_id IS NULL
    `).get(
      input.approvalId,
      input.candidateId,
      input.runId,
      input.claimToken,
      nowIso,
      input.sourceId,
    );
    if (!claim) throw new Error('Research delivery claim is stale or no longer writable');

    const job: Job = {
      id: randomUUID(),
      type: 'ingest',
      status: 'pending',
      subjectId: input.subjectId,
      paramsJson: JSON.stringify({
        researchProvenance: {
          runId: input.runId,
          approvalId: input.approvalId,
          candidateId: input.candidateId,
        },
        sourceId: input.sourceId,
        filename: source.filename,
        subjectId: input.subjectId,
      }),
      resultJson: null,
      createdAt: nowIso,
      startedAt: null,
      completedAt: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      attemptCount: 0,
    };
    sqlite.prepare(`
      INSERT INTO jobs (
        id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, 0)
    `).run(job.id, job.type, job.status, job.subjectId, job.paramsJson, job.createdAt);
    markResearchDeliveryQueuedInTransaction(sqlite, {
      approvalId: input.approvalId,
      candidateId: input.candidateId,
      claimToken: input.claimToken,
      sourceId: input.sourceId,
      ingestJobId: job.id,
      now,
    });
    return job;
  });
  return transaction.immediate();
}

/** queued child 进入 running 时同步 delivery；重复调用幂等。 */
export function markResearchDeliveryRunning(
  approvalId: string,
  candidateId: string,
  ingestJobId: string,
  now = new Date(),
): boolean {
  const result = getRawDb().prepare(`
    UPDATE research_candidate_ingests
    SET status = 'running', updated_at = ?
    WHERE approval_id = ? AND candidate_id = ? AND ingest_job_id = ?
      AND status = 'queued'
  `).run(now.toISOString(), approvalId, candidateId, ingestJobId);
  return result.changes === 1;
}

/** child Ingest 完成后原子物化审计证据并终结 delivery。 */
export function completeResearchDeliveryAtomic(input: CompleteResearchDeliveryInput): boolean {
  const nowIso = (input.now ?? new Date()).toISOString();
  const result = getRawDb().prepare(`
    UPDATE research_candidate_ingests
    SET status = 'completed', source_id = ?, operation_ids_json = ?,
        touched_pages_json = ?, commit_sha = ?, claim_token = NULL,
        lease_expires_at = NULL, updated_at = ?, completed_at = ?, error_json = NULL
    WHERE approval_id = ? AND candidate_id = ? AND ingest_job_id = ?
      AND status IN ('queued', 'running')
  `).run(
    input.sourceId,
    JSON.stringify([...new Set(input.operationIds)].sort()),
    JSON.stringify(input.touchedPages),
    input.commitSha,
    nowIso,
    nowIso,
    input.approvalId,
    input.candidateId,
    input.ingestJobId,
  );
  return result.changes === 1;
}

/** child Ingest 失败后终结 delivery；只接受当前绑定的 child job。 */
export function failResearchDeliveryFromJob(
  approvalId: string,
  candidateId: string,
  ingestJobId: string,
  error: { code?: string; message: string },
  now = new Date(),
): boolean {
  const nowIso = now.toISOString();
  const result = getRawDb().prepare(`
    UPDATE research_candidate_ingests
    SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
        updated_at = ?, completed_at = ?, error_json = ?
    WHERE approval_id = ? AND candidate_id = ? AND ingest_job_id = ?
      AND status IN ('queued', 'running')
  `).run(
    nowIso,
    nowIso,
    JSON.stringify(error),
    approvalId,
    candidateId,
    ingestJobId,
  );
  return result.changes === 1;
}

/** coordinator 最终失败或取消时，终结尚未调度的 delivery。 */
export function failUnscheduledResearchDeliveries(
  runId: string,
  error: { code?: string; message: string },
  now = new Date(),
): number {
  const nowIso = now.toISOString();
  const result = getRawDb().prepare(`
    UPDATE research_candidate_ingests
    SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
        updated_at = ?, completed_at = ?, error_json = ?
    WHERE run_id = ? AND status IN ('pending', 'fetching')
  `).run(nowIso, nowIso, JSON.stringify(error), runId);
  return result.changes;
}

/** topic run 在全部 delivery 终态后直接聚合 completed/partial/failed。 */
export function finalizeTopicResearchRunAtomic(runId: string, now = new Date()): boolean {
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): boolean => {
    const run = sqlite.prepare(`
      SELECT origin, status FROM research_runs WHERE id = ?
    `).get(runId) as { origin: string; status: string } | undefined;
    if (!run || run.origin !== 'topic' || run.status !== 'importing') return false;
    const counts = researchDeliveryCounts(sqlite, runId);
    if (counts.total === 0 || counts.terminal !== counts.total) return false;
    const status = counts.completed === counts.total
      ? 'completed'
      : counts.completed > 0 ? 'partial' : 'failed';
    const nowIso = now.toISOString();
    const update = sqlite.prepare(`
      UPDATE research_runs
      SET status = ?, version = version + 1, updated_at = ?, completed_at = ?
      WHERE id = ? AND status = 'importing' AND origin = 'topic'
    `).run(status, nowIso, nowIso, runId);
    return update.changes === 1;
  });
  return transaction.immediate();
}

/** finding run 全部 delivery 失败时不创建 lint，直接聚合 failed。 */
export function failFindingResearchRunWithoutDelivery(
  runId: string,
  now = new Date(),
): boolean {
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): boolean => {
    const counts = researchDeliveryCounts(sqlite, runId);
    if (counts.total === 0 || counts.terminal !== counts.total || counts.completed > 0) return false;
    const nowIso = now.toISOString();
    const update = sqlite.prepare(`
      UPDATE research_runs
      SET status = 'failed', version = version + 1, updated_at = ?, completed_at = ?
      WHERE id = ? AND status = 'importing' AND origin = 'findings'
        AND verification_lint_job_id IS NULL
    `).run(nowIso, nowIso, runId);
    return update.changes === 1;
  });
  return transaction.immediate();
}

export interface RetryResearchRunImportInput {
  runId: string;
  subjectId: SubjectId;
  expectedVersion: number;
  now?: Date;
}

export interface RetryResearchRunImportResult {
  stored: StoredResearchRun;
  coordinatorJobId: string;
}

export interface RetryResearchIngestJobInput {
  runId: string;
  subjectId: SubjectId;
  approvalId: string;
  candidateId: string;
  ingestJobId: string;
  now?: Date;
}

/**
 * failed Research child Ingest 的原位续传原语：保留 job ID 与 checkpoint，
 * 同时恢复 delivery/run 状态，避免独立 requeue 绕过 provenance 状态机。
 */
export function retryResearchIngestJobAtomic(
  input: RetryResearchIngestJobInput,
): StoredResearchRun {
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): StoredResearchRun => {
    const stored = findResearchRunByIdRaw(sqlite, input.runId, input.subjectId);
    if (!stored) {
      throw new ResearchProvenanceRepoError('run-not-found', 'Research run not found');
    }
    if (
      !['importing', 'partial', 'failed'].includes(stored.run.status)
      || stored.run.verificationLintJobId
      || stored.findings.some((finding) => finding.verificationStatus !== 'pending')
    ) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research child ingest failed after the run became terminal or entered verification',
      );
    }
    if (!stored.approval || stored.approval.id !== input.approvalId) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research child ingest approval evidence does not match',
      );
    }

    const delivery = stored.deliveries.find((row) => (
      row.approvalId === input.approvalId
      && row.candidateId === input.candidateId
      && row.ingestJobId === input.ingestJobId
    ));
    if (!delivery || delivery.status !== 'failed' || !delivery.sourceId) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research child ingest delivery is not retryable',
      );
    }

    const job = sqlite.prepare(`
      SELECT type, status, subject_id, cancel_requested, result_json
      FROM jobs WHERE id = ?
    `).get(input.ingestJobId) as {
      type: string;
      status: string;
      subject_id: string | null;
      cancel_requested: number | null;
      result_json: string | null;
    } | undefined;
    if (
      !job
      || job.type !== 'ingest'
      || job.status !== 'failed'
      || job.subject_id !== input.subjectId
      || job.cancel_requested === 1
      || isCancelledJobResult(job.result_json)
    ) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research child ingest job is not retryable',
      );
    }

    const source = sqlite.prepare(`
      SELECT 1 FROM sources WHERE id = ? AND subject_id = ?
    `).get(delivery.sourceId, input.subjectId);
    if (!source) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research child ingest source is unavailable',
      );
    }

    const nowIso = (input.now ?? new Date()).toISOString();
    const jobUpdate = sqlite.prepare(`
      UPDATE jobs
      SET status = 'pending', result_json = NULL, completed_at = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL, cancel_requested = 0
      WHERE id = ? AND type = 'ingest' AND status = 'failed'
        AND subject_id = ? AND cancel_requested = 0
    `).run(input.ingestJobId, input.subjectId);
    if (jobUpdate.changes !== 1) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research child ingest changed concurrently',
      );
    }

    const deliveryUpdate = sqlite.prepare(`
      UPDATE research_candidate_ingests
      SET status = 'queued', completed_at = NULL, error_json = NULL,
          operation_ids_json = '[]', touched_pages_json = '[]', commit_sha = NULL,
          claim_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE approval_id = ? AND candidate_id = ? AND run_id = ?
        AND ingest_job_id = ? AND status = 'failed' AND source_id = ?
    `).run(
      nowIso,
      input.approvalId,
      input.candidateId,
      input.runId,
      input.ingestJobId,
      delivery.sourceId,
    );
    if (deliveryUpdate.changes !== 1) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research child ingest delivery changed concurrently',
      );
    }

    const runUpdate = sqlite.prepare(`
      UPDATE research_runs
      SET status = 'importing', version = version + 1, updated_at = ?,
          completed_at = NULL, error_json = NULL
      WHERE id = ? AND subject_id = ? AND status = ? AND version = ?
    `).run(
      nowIso,
      input.runId,
      input.subjectId,
      stored.run.status,
      stored.run.version,
    );
    if (runUpdate.changes !== 1) {
      throw new ResearchProvenanceRepoError(
        'run-stale',
        'Research run version changed concurrently',
      );
    }

    const latest = findResearchRunByIdRaw(sqlite, input.runId, input.subjectId);
    if (!latest) throw new Error('Failed to reload retried Research run');
    return latest;
  });
  return transaction.immediate();
}

/**
 * failed run 的导入重试原语：只接受尚未进入 verification 的 failed run，
 * 把 failed delivery 重置回 pending、换发新的 research-import coordinator、
 * run CAS 回 importing；重置/换发/回写在同一 IMMEDIATE transaction 中完成，
 * 之后由既有 reconciler 闭环接管。
 */
export function retryResearchRunImportAtomic(
  input: RetryResearchRunImportInput,
): RetryResearchRunImportResult {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new ResearchProvenanceRepoError(
      'run-stale',
      'Research retry expectedVersion must be a positive integer',
    );
  }
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): RetryResearchRunImportResult => {
    const stored = findResearchRunByIdRaw(sqlite, input.runId, input.subjectId);
    if (!stored) {
      throw new ResearchProvenanceRepoError('run-not-found', 'Research run not found');
    }
    if (stored.run.status !== 'failed') {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        `Research run is not in a retryable state: ${stored.run.status}`,
      );
    }
    if (
      stored.run.verificationLintJobId
      || stored.findings.some((finding) => finding.verificationStatus !== 'pending')
    ) {
      // 目标化验证或旧 verification lint 已物化 finding 终态，导入重试无法恢复语义。
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research run failed after verification and cannot retry the import',
      );
    }
    if (!stored.approval || stored.deliveries.length === 0) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research run has no approval evidence to retry',
      );
    }
    if (stored.run.version !== input.expectedVersion) {
      throw new ResearchProvenanceRepoError('run-stale', 'Research run version is stale');
    }

    const nowIso = (input.now ?? new Date()).toISOString();
    // 保留 source_id 使 coordinator 走既有"从现有来源恢复"路径，避免重复抓取；
    // attempt_count 保留为历史证据，由下一次 claim 继续累加。
    const reset = sqlite.prepare(`
      UPDATE research_candidate_ingests
      SET status = 'pending', ingest_job_id = NULL, claim_token = NULL,
          lease_expires_at = NULL, completed_at = NULL, error_json = NULL,
          operation_ids_json = '[]', touched_pages_json = '[]', commit_sha = NULL,
          updated_at = ?
      WHERE run_id = ? AND status = 'failed'
    `).run(nowIso, input.runId);
    if (reset.changes === 0) {
      throw new ResearchProvenanceRepoError(
        'run-not-retryable',
        'Research run has no failed candidate imports to retry',
      );
    }

    const coordinatorJobId = randomUUID();
    sqlite.prepare(`
      INSERT INTO jobs (
        id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count
      ) VALUES (?, 'research-import', 'pending', ?, ?, NULL, ?,
        NULL, NULL, NULL, NULL, 0)
    `).run(
      coordinatorJobId,
      input.subjectId,
      JSON.stringify({
        approvalId: stored.approval.id,
        runId: input.runId,
        subjectId: input.subjectId,
      }),
      nowIso,
    );
    const approvalUpdate = sqlite.prepare(`
      UPDATE research_approvals SET coordinator_job_id = ?
      WHERE id = ? AND run_id = ?
    `).run(coordinatorJobId, stored.approval.id, input.runId);
    if (approvalUpdate.changes !== 1) {
      throw new Error('Research approval coordinator handoff changed concurrently');
    }

    const runUpdate = sqlite.prepare(`
      UPDATE research_runs
      SET status = 'importing', version = version + 1, updated_at = ?,
          completed_at = NULL, error_json = NULL
      WHERE id = ? AND subject_id = ? AND status = 'failed' AND version = ?
    `).run(nowIso, input.runId, input.subjectId, input.expectedVersion);
    if (runUpdate.changes !== 1) {
      throw new ResearchProvenanceRepoError('run-stale', 'Research run version changed concurrently');
    }

    const latest = findResearchRunByIdRaw(sqlite, input.runId, input.subjectId);
    if (!latest) throw new Error('Failed to reload retried Research run');
    return { stored: latest, coordinatorJobId };
  });
  return transaction.immediate();
}

/** 目标化 postcondition（verificationJobId=null）或旧 lint verification 的结果与 run 终态原子物化。 */
export function finalizeResearchVerificationAtomic(
  runId: string,
  verificationJobId: string | null,
  outcomes: ResearchFindingVerificationOutcome[],
  status: 'completed' | 'partial' | 'failed',
  error: { code?: string; message: string } | null,
  now = new Date(),
): boolean {
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): boolean => {
    const run = sqlite.prepare(`
      SELECT status, verification_lint_job_id FROM research_runs WHERE id = ?
    `).get(runId) as {
      status: string;
      verification_lint_job_id: string | null;
    } | undefined;
    const expectedStatus = verificationJobId === null ? 'importing' : 'verifying';
    if (
      !run
      || run.status !== expectedStatus
      || run.verification_lint_job_id !== verificationJobId
    ) return false;
    const rows = sqlite.prepare(`
      SELECT finding_id FROM research_run_findings WHERE run_id = ? ORDER BY finding_id
    `).all(runId) as Array<{ finding_id: string }>;
    const expected = rows.map((row) => row.finding_id);
    const received = [...outcomes].map((outcome) => outcome.findingId).sort();
    if (!sameStringArray(expected, received)) {
      throw new Error('Research verification outcomes do not cover the persisted findings');
    }
    const nowIso = now.toISOString();
    const updateFinding = sqlite.prepare(`
      UPDATE research_run_findings
      SET verification_status = ?, verified_at = ?, verification_snapshot_json = ?
      WHERE run_id = ? AND finding_id = ? AND verification_status = 'pending'
    `);
    for (const outcome of outcomes) {
      const update = updateFinding.run(
        outcome.status,
        nowIso,
        outcome.snapshot === null ? null : JSON.stringify(outcome.snapshot),
        runId,
        outcome.findingId,
      );
      if (update.changes !== 1) throw new Error('Research finding verification changed concurrently');
    }
    const runUpdate = verificationJobId === null
      ? sqlite.prepare(`
          UPDATE research_runs
          SET status = ?, version = version + 1, updated_at = ?, completed_at = ?, error_json = ?
          WHERE id = ? AND status = 'importing' AND verification_lint_job_id IS NULL
        `).run(status, nowIso, nowIso, error ? JSON.stringify(error) : null, runId)
      : sqlite.prepare(`
          UPDATE research_runs
          SET status = ?, version = version + 1, updated_at = ?, completed_at = ?, error_json = ?
          WHERE id = ? AND status = 'verifying' AND verification_lint_job_id = ?
        `).run(
          status,
          nowIso,
          nowIso,
          error ? JSON.stringify(error) : null,
          runId,
          verificationJobId,
        );
    if (runUpdate.changes !== 1) {
      throw new Error('Research finding postcondition changed concurrently');
    }
    return true;
  });
  return transaction.immediate();
}

/** 启动/维护扫描只读取尚未终态的 run，返回有界稳定 ID。 */
export function listResearchRunIdsForReconciliation(limit = 100): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Research reconcile limit must be positive');
  return (getRawDb().prepare(`
    SELECT id FROM research_runs
    WHERE status IN ('importing', 'verifying')
    ORDER BY updated_at ASC, id ASC LIMIT ?
  `).all(limit) as Array<{ id: string }>).map((row) => row.id);
}

/** job 终态 hook 按 coordinator/child/verification 三条 lineage 定位 run。 */
export function findResearchRunIdsByJobId(jobId: string): string[] {
  return (getRawDb().prepare(`
    SELECT id FROM research_runs WHERE verification_lint_job_id = ?
    UNION
    SELECT run_id AS id FROM research_approvals WHERE coordinator_job_id = ?
    UNION
    SELECT run_id AS id FROM research_candidate_ingests WHERE ingest_job_id = ?
  `).all(jobId, jobId, jobId) as Array<{ id: string }>).map((row) => row.id);
}

/** awaiting-approval → dismissed 的 compare-and-swap。 */
export function dismissResearchRunAtomic(
  runId: string,
  subjectId: SubjectId,
): StoredResearchRun {
  const sqlite = getRawDb();
  const transaction = sqlite.transaction((): StoredResearchRun => {
    const existing = findResearchRunByIdRaw(sqlite, runId, subjectId);
    if (!existing) {
      throw new ResearchProvenanceRepoError('run-not-found', 'Research run not found');
    }
    if (existing.run.status !== 'awaiting-approval' || existing.approval) {
      throw new ResearchProvenanceRepoError(
        'run-not-approvable',
        'Only a Research run awaiting approval can be dismissed',
      );
    }

    const now = new Date().toISOString();
    sqlite.prepare(`
      UPDATE research_candidates
      SET decision = 'rejected', decided_at = ?
      WHERE run_id = ? AND decision = 'pending'
    `).run(now, runId);
    const update = sqlite.prepare(`
      UPDATE research_runs
      SET status = 'dismissed', version = version + 1,
          updated_at = ?, completed_at = ?
      WHERE id = ? AND subject_id = ? AND status = 'awaiting-approval' AND version = ?
    `).run(now, now, runId, subjectId, existing.run.version);
    if (update.changes !== 1) {
      throw new ResearchProvenanceRepoError('run-stale', 'Research run changed concurrently');
    }

    const dismissed = findResearchRunByIdRaw(sqlite, runId, subjectId);
    if (!dismissed) throw new Error('Failed to reload dismissed Research run');
    return dismissed;
  });
  return transaction.immediate();
}

function validateRunInput(input: PersistResearchRunInput): void {
  if (!input.subjectId || !input.researchJobId) throw new Error('Research run identity is required');
  if (input.origin === 'topic') {
    if (!input.topic || input.lintJobId !== null || input.findings.length !== 0) {
      throw new Error('Manual topic Research run has inconsistent origin fields');
    }
  } else if (!input.lintJobId || input.topic !== null || input.findings.length === 0) {
    throw new Error('Finding Research run has inconsistent origin fields');
  }
  if (![...input.topics, ...input.queries].every((value) => typeof value === 'string')) {
    throw new Error('Research topics and queries must be strings');
  }
  const findingIds = new Set<string>();
  for (const finding of input.findings) {
    if (!/^[0-9a-f]{64}$/.test(finding.findingId) || findingIds.has(finding.findingId)) {
      throw new Error('Research finding IDs must be unique lowercase SHA-256 values');
    }
    findingIds.add(finding.findingId);
    const snapshot = parseResearchFindingSnapshot(finding.snapshot);
    if (findingId({ ...snapshot, subjectId: input.subjectId }) !== finding.findingId) {
      throw new Error('Research finding ID does not match its immutable snapshot');
    }
  }
}

function findResearchRunByIdRaw(
  sqlite: RawDb,
  runId: string,
  subjectId?: SubjectId,
): StoredResearchRun | null {
  const row = subjectId === undefined
    ? sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(runId)
    : sqlite.prepare('SELECT * FROM research_runs WHERE id = ? AND subject_id = ?')
      .get(runId, subjectId);
  return row ? hydrateResearchRun(sqlite, row as RawRow) : null;
}

function hydrateResearchRun(sqlite: RawDb, rawRun: RawRow): StoredResearchRun {
  const run = researchRunRow(rawRun);
  const findings = (sqlite.prepare(`
    SELECT * FROM research_run_findings
    WHERE run_id = ? ORDER BY finding_id ASC
  `).all(run.id) as RawRow[]).map(researchRunFindingRow);
  const candidates = (sqlite.prepare(`
    SELECT * FROM research_candidates
    WHERE run_id = ? ORDER BY rank ASC, id ASC
  `).all(run.id) as RawRow[]).map(researchCandidateRow);
  const approvalRaw = sqlite.prepare(
    'SELECT * FROM research_approvals WHERE run_id = ?',
  ).get(run.id) as RawRow | undefined;
  const deliveries = (sqlite.prepare(`
    SELECT d.* FROM research_candidate_ingests d
    JOIN research_candidates c ON c.id = d.candidate_id AND c.run_id = d.run_id
    WHERE d.run_id = ? ORDER BY c.rank ASC, d.candidate_id ASC
  `).all(run.id) as RawRow[]).map(researchCandidateIngestRow);
  return {
    run,
    findings,
    candidates,
    approval: approvalRaw ? researchApprovalRow(approvalRaw) : null,
    deliveries,
  };
}

function researchRunRow(row: RawRow): ResearchRunRow {
  return {
    id: String(row.id),
    subjectId: String(row.subject_id),
    researchJobId: String(row.research_job_id),
    origin: row.origin as ResearchRunRow['origin'],
    lintJobId: nullableString(row.lint_job_id),
    topic: nullableString(row.topic),
    topicsJson: String(row.topics_json),
    queriesJson: String(row.queries_json),
    candidateSetHash: String(row.candidate_set_hash),
    status: row.status as ResearchRunRow['status'],
    version: Number(row.version),
    verificationLintJobId: nullableString(row.verification_lint_job_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: nullableString(row.completed_at),
    errorJson: nullableString(row.error_json),
  };
}

function researchRunFindingRow(row: RawRow): ResearchRunFindingRow {
  return {
    runId: String(row.run_id),
    findingId: String(row.finding_id),
    snapshotJson: String(row.snapshot_json),
    verificationStatus: row.verification_status as ResearchRunFindingRow['verificationStatus'],
    verifiedAt: nullableString(row.verified_at),
    verificationSnapshotJson: nullableString(row.verification_snapshot_json),
  };
}

function researchCandidateRow(row: RawRow): ResearchCandidateRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    normalizedUrl: String(row.normalized_url),
    snapshotJson: String(row.snapshot_json),
    rank: Number(row.rank),
    decision: row.decision as ResearchCandidateRow['decision'],
    approvalId: nullableString(row.approval_id),
    decidedAt: nullableString(row.decided_at),
  };
}

function researchApprovalRow(row: RawRow): ResearchApprovalRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    selectedCandidateIdsJson: String(row.selected_candidate_ids_json),
    payloadHash: String(row.payload_hash),
    idempotencyKey: String(row.idempotency_key),
    coordinatorJobId: String(row.coordinator_job_id),
    createdAt: String(row.created_at),
  };
}

function researchCandidateIngestRow(row: RawRow): ResearchCandidateIngestRow {
  return {
    approvalId: String(row.approval_id),
    candidateId: String(row.candidate_id),
    runId: String(row.run_id),
    normalizedUrl: String(row.normalized_url),
    status: row.status as ResearchCandidateIngestRow['status'],
    sourceId: nullableString(row.source_id),
    ingestJobId: nullableString(row.ingest_job_id),
    operationIdsJson: String(row.operation_ids_json),
    touchedPagesJson: String(row.touched_pages_json),
    commitSha: nullableString(row.commit_sha),
    claimToken: nullableString(row.claim_token),
    leaseExpiresAt: nullableString(row.lease_expires_at),
    attemptCount: Number(row.attempt_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: nullableString(row.completed_at),
    errorJson: nullableString(row.error_json),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parsePersistedSelection(json: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Persisted Research approval selection is invalid');
  }
  if (!Array.isArray(value) || !value.every((candidateId) => typeof candidateId === 'string')) {
    throw new Error('Persisted Research approval selection is invalid');
  }
  const canonical = canonicalizeResearchSelection(value);
  if (!sameStringArray(canonical, value)) {
    throw new Error('Persisted Research approval selection is not canonical');
  }
  return canonical;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isCancelledJobResult(resultJson: string | null): boolean {
  if (!resultJson) return false;
  try {
    const value: unknown = JSON.parse(resultJson);
    return !!value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as { cancelled?: unknown }).cancelled === true;
  } catch {
    return false;
  }
}

function assertLeaseDuration(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error('Research delivery lease must be a positive integer');
  }
}

function researchDeliveryCounts(
  sqlite: RawDb,
  runId: string,
): { total: number; terminal: number; completed: number } {
  const row = sqlite.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('completed', 'failed') THEN 1 ELSE 0 END) AS terminal,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM research_candidate_ingests WHERE run_id = ?
  `).get(runId) as { total: number; terminal: number | null; completed: number | null };
  return {
    total: Number(row.total),
    terminal: Number(row.terminal ?? 0),
    completed: Number(row.completed ?? 0),
  };
}
