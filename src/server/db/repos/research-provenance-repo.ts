import { randomUUID } from 'node:crypto';
import type {
  ResearchApprovalRow,
  ResearchCandidateIngestRow,
  ResearchCandidateRow,
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
  | 'run-not-approvable';

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
