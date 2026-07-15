import type {
  EnrichedLintFinding,
  ResearchApiErrorCode,
  ResearchCandidateDeliveryView,
  ResearchCandidateView,
  ResearchFindingView,
  ResearchRunView,
  ResearchTouchedPage,
} from '@/lib/contracts';
import * as researchRepo from '../db/repos/research-provenance-repo';
import {
  ResearchProvenanceRepoError,
  type StoredResearchRun,
} from '../db/repos/research-provenance-repo';
import {
  canonicalizeResearchSelection,
  parseResearchFindingSnapshot,
  ResearchProvenanceError,
  validateStoredResearchCandidates,
} from './research-provenance';
import { findingId } from './finding-identity';
import { reconcileResearchProvenanceForJob } from './research-provenance-reconciler';

const SAFE_MESSAGE_LIMIT = 500;
const SENSITIVE_MESSAGE_PATTERN = /(?:https?:\/\/|file:\/\/|\/(?:Users|home|private|var|etc)\/|[a-z]:\\|bearer\s+|sk-[a-z0-9_-]+|(?:api[-_ ]?key|token|authorization|password|credential)\s*[:=])/i;

export class ResearchApprovalServiceError extends Error {
  constructor(
    readonly code: ResearchApiErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly run?: ResearchRunView,
  ) {
    super(message);
    this.name = 'ResearchApprovalServiceError';
  }
}

export interface ApproveResearchRunServiceInput {
  runId: string;
  subjectId: string;
  candidateIds: string[];
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ApproveResearchRunServiceResult {
  run: ResearchRunView;
  coordinatorJobId: string;
  replayed: boolean;
}

export function mapStoredResearchRunToView(stored: StoredResearchRun): ResearchRunView {
  try {
    return mapStoredResearchRunToViewUnsafe(stored);
  } catch (error) {
    if (error instanceof ResearchApprovalServiceError) throw error;
    throw invalidStoredEvidence();
  }
}

export function getResearchRun(runId: string, subjectId: string): ResearchRunView {
  const stored = researchRepo.findResearchRunById(runId, subjectId);
  if (!stored) throw notFound();
  return mapStoredResearchRunToView(stored);
}

export function getResearchRunByJobId(
  researchJobId: string,
  subjectId: string,
): ResearchRunView | null {
  const stored = researchRepo.findResearchRunByJobId(researchJobId, subjectId);
  return stored ? mapStoredResearchRunToView(stored) : null;
}

export function getResearchRunsByJobIds(
  researchJobIds: string[],
  subjectId: string,
): ResearchRunView[] {
  return researchRepo.findResearchRunsByJobIds(researchJobIds, subjectId)
    .map(mapStoredResearchRunToView);
}

export function approveResearchRun(
  input: ApproveResearchRunServiceInput,
): ApproveResearchRunServiceResult {
  try {
    const result = researchRepo.approveResearchRunAtomic(input);
    return {
      run: mapStoredResearchRunToView(result.stored),
      coordinatorJobId: result.coordinatorJobId,
      replayed: result.replayed,
    };
  } catch (error) {
    throw mapApprovalError(error, input.runId, input.subjectId);
  }
}

export interface RetryResearchRunServiceInput {
  runId: string;
  subjectId: string;
  expectedVersion: number;
}

export interface RetryResearchRunServiceResult {
  run: ResearchRunView;
  coordinatorJobId: string;
}

export interface RetryResearchIngestJobServiceInput {
  runId: string;
  subjectId: string;
  approvalId: string;
  candidateId: string;
  ingestJobId: string;
}

export interface RetryResearchIngestJobServiceResult {
  run: ResearchRunView;
}

/** failed child job 先完成终态对账，再原子恢复同一 job、delivery 与 run。 */
export function retryResearchIngestJob(
  input: RetryResearchIngestJobServiceInput,
): RetryResearchIngestJobServiceResult {
  reconcileResearchProvenanceForJob(input.ingestJobId);
  try {
    return {
      run: mapStoredResearchRunToView(
        researchRepo.retryResearchIngestJobAtomic(input),
      ),
    };
  } catch (error) {
    throw mapApprovalError(error, input.runId, input.subjectId);
  }
}

/** failed run 的导入重试：重置 failed delivery、换发 coordinator，run 回到 importing。 */
export function retryResearchRunImport(
  input: RetryResearchRunServiceInput,
): RetryResearchRunServiceResult {
  try {
    const result = researchRepo.retryResearchRunImportAtomic(input);
    return {
      run: mapStoredResearchRunToView(result.stored),
      coordinatorJobId: result.coordinatorJobId,
    };
  } catch (error) {
    throw mapApprovalError(error, input.runId, input.subjectId);
  }
}

export function dismissResearchRun(runId: string, subjectId: string): ResearchRunView {
  try {
    return mapStoredResearchRunToView(
      researchRepo.dismissResearchRunAtomic(runId, subjectId),
    );
  } catch (error) {
    throw mapApprovalError(error, runId, subjectId);
  }
}

function mapStoredResearchRunToViewUnsafe(stored: StoredResearchRun): ResearchRunView {
  const snapshots = validateStoredResearchCandidates(
    stored.run.id,
    stored.run.candidateSetHash,
    stored.candidates,
  );
  const candidateRows = new Map(stored.candidates.map((candidate) => [candidate.id, candidate]));
  const deliveries = new Map<string, ResearchCandidateDeliveryView>();
  for (const delivery of stored.deliveries) {
    const candidate = candidateRows.get(delivery.candidateId);
    if (
      !candidate
      || delivery.runId !== stored.run.id
      || delivery.normalizedUrl !== candidate.normalizedUrl
      || delivery.approvalId !== stored.approval?.id
      || deliveries.has(delivery.candidateId)
    ) {
      throw invalidStoredEvidence();
    }
    deliveries.set(delivery.candidateId, deliveryToView(delivery));
  }

  const selection = stored.approval
    ? parseApprovalSelection(stored.approval.selectedCandidateIdsJson)
    : [];
  const selected = new Set(selection);
  if (stored.approval) {
    if (stored.approval.runId !== stored.run.id) throw invalidStoredEvidence();
    if (selection.some((candidateId) => !candidateRows.has(candidateId))) {
      throw invalidStoredEvidence();
    }
  } else if (stored.deliveries.length > 0) {
    throw invalidStoredEvidence();
  }

  if (
    (stored.approval && ['awaiting-approval', 'dismissed', 'empty'].includes(stored.run.status))
    || (!stored.approval && !['awaiting-approval', 'dismissed', 'empty'].includes(stored.run.status))
  ) {
    throw invalidStoredEvidence();
  }

  const candidates: ResearchCandidateView[] = snapshots.map((snapshot) => {
    const row = candidateRows.get(snapshot.id);
    if (!row) throw invalidStoredEvidence();
    const delivery = deliveries.get(snapshot.id) ?? null;
    if (stored.approval) {
      const shouldApprove = selected.has(snapshot.id);
      if (
        row.approvalId !== stored.approval.id
        || row.decision !== (shouldApprove ? 'approved' : 'rejected')
        || (shouldApprove && !delivery)
        || (!shouldApprove && delivery)
      ) {
        throw invalidStoredEvidence();
      }
    } else if (row.approvalId !== null || delivery) {
      throw invalidStoredEvidence();
    }
    return { ...snapshot, decision: row.decision, delivery };
  });
  if (
    (!stored.approval && stored.run.status === 'awaiting-approval'
      && candidates.some((candidate) => candidate.decision !== 'pending'))
    || (!stored.approval && stored.run.status === 'dismissed'
      && candidates.some((candidate) => candidate.decision !== 'rejected'))
    || (stored.run.status === 'empty' && candidates.length > 0)
  ) {
    throw invalidStoredEvidence();
  }

  const findings = stored.findings
    .map((finding) => findingToView(stored, finding))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));

  return {
    id: stored.run.id,
    subjectId: stored.run.subjectId,
    researchJobId: stored.run.researchJobId,
    origin: stored.run.origin,
    lintJobId: stored.run.lintJobId,
    topic: stored.run.topic,
    topics: parseStringArrayOrEmpty(stored.run.topicsJson),
    queries: parseStringArrayOrEmpty(stored.run.queriesJson),
    candidateSetHash: stored.run.candidateSetHash,
    status: stored.run.status,
    version: stored.run.version,
    verificationLintJobId: stored.run.verificationLintJobId,
    findings,
    candidates,
    approval: stored.approval ? {
      id: stored.approval.id,
      selectedCandidateIds: selection,
      coordinatorJobId: stored.approval.coordinatorJobId,
      createdAt: stored.approval.createdAt,
    } : null,
    createdAt: stored.run.createdAt,
    updatedAt: stored.run.updatedAt,
    completedAt: stored.run.completedAt,
    error: parseSafeError(stored.run.errorJson, 'Research workflow failed.'),
  };
}

function findingToView(
  stored: StoredResearchRun,
  row: StoredResearchRun['findings'][number],
): ResearchFindingView {
  const snapshot = parseJson(row.snapshotJson);
  const parsed = parseResearchFindingSnapshot(snapshot);
  const expectedId = findingId({ ...parsed, subjectId: stored.run.subjectId });
  if (row.runId !== stored.run.id || expectedId !== row.findingId) {
    throw invalidStoredEvidence();
  }
  return {
    findingId: row.findingId,
    finding: toEnrichedFinding(row.findingId, stored.run.subjectId, parsed),
    verificationStatus: row.verificationStatus,
    verifiedAt: row.verifiedAt,
    verificationFinding: parseVerificationFinding(
      row.verificationSnapshotJson,
      stored.run.subjectId,
    ),
  };
}

function parseVerificationFinding(
  json: string | null,
  subjectId: string,
): EnrichedLintFinding | null {
  if (!json) return null;
  try {
    const snapshot = parseResearchFindingSnapshot(parseJson(json));
    const id = findingId({ ...snapshot, subjectId });
    return toEnrichedFinding(id, subjectId, snapshot);
  } catch {
    return null;
  }
}

function toEnrichedFinding(
  id: string,
  subjectId: string,
  snapshot: ReturnType<typeof parseResearchFindingSnapshot>,
): EnrichedLintFinding {
  return { id, subjectId, ...snapshot };
}

function deliveryToView(
  delivery: StoredResearchRun['deliveries'][number],
): ResearchCandidateDeliveryView {
  return {
    status: delivery.status,
    sourceId: delivery.sourceId,
    ingestJobId: delivery.ingestJobId,
    operationIds: [...new Set(parseStringArrayOrEmpty(delivery.operationIdsJson))].sort(),
    touchedPages: parseTouchedPagesOrEmpty(delivery.touchedPagesJson),
    commitSha: delivery.commitSha,
    attemptCount: delivery.attemptCount,
    completedAt: delivery.completedAt,
    error: parseSafeError(delivery.errorJson, 'Candidate import failed.'),
  };
}

function parseTouchedPagesOrEmpty(json: string): ResearchTouchedPage[] {
  try {
    const value = parseJson(json);
    if (!Array.isArray(value)) return [];
    const bySlug = new Map<string, ResearchTouchedPage>();
    for (const item of value) {
      if (!isRecord(item)) return [];
      if (
        typeof item.slug !== 'string'
        || item.slug.length === 0
        || (item.action !== 'created' && item.action !== 'updated')
        || typeof item.system !== 'boolean'
      ) {
        return [];
      }
      const previous = bySlug.get(item.slug);
      bySlug.set(item.slug, {
        slug: item.slug,
        action: previous?.action === 'created' || item.action === 'created'
          ? 'created'
          : 'updated',
        system: (previous?.system ?? false) || item.system,
      });
    }
    return [...bySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug));
  } catch {
    return [];
  }
}

function parseApprovalSelection(json: string): string[] {
  const value = parseJson(json);
  if (!Array.isArray(value) || !value.every((candidateId) => typeof candidateId === 'string')) {
    throw invalidStoredEvidence();
  }
  const canonical = canonicalizeResearchSelection(value);
  if (!sameStringArray(canonical, value)) throw invalidStoredEvidence();
  return canonical;
}

function parseStringArrayOrEmpty(json: string): string[] {
  try {
    const value = parseJson(json);
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
      ? value
      : [];
  } catch {
    return [];
  }
}

function parseSafeError(
  json: string | null,
  fallback: string,
): { code?: string; message: string } | null {
  if (!json) return null;
  try {
    const value = parseJson(json);
    if (!isRecord(value) || typeof value.message !== 'string') {
      return { message: 'Stored error details are unavailable.' };
    }
    const message = value.message.trim();
    if (
      message.length === 0
      || message.length > SAFE_MESSAGE_LIMIT
      || SENSITIVE_MESSAGE_PATTERN.test(message)
    ) {
      return { message: fallback };
    }
    return typeof value.code === 'string'
      ? { code: value.code, message }
      : { message };
  } catch {
    return { message: 'Stored error details are unavailable.' };
  }
}

function parseJson(json: string): unknown {
  return JSON.parse(json) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function mapApprovalError(
  error: unknown,
  runId: string,
  subjectId: string,
): unknown {
  if (error instanceof ResearchApprovalServiceError) return error;
  if (error instanceof ResearchProvenanceError) {
    return error.code === 'invalid-selection'
      ? new ResearchApprovalServiceError(
        'RESEARCH_SELECTION_INVALID',
        'Research candidate selection is invalid.',
        400,
      )
      : invalidStoredEvidence();
  }
  if (!(error instanceof ResearchProvenanceRepoError)) return error;

  const mappings: Record<string, [ResearchApiErrorCode, string, number]> = {
    'run-not-found': ['RESEARCH_RUN_NOT_FOUND', 'Research run not found.', 404],
    'run-subject-conflict': ['RESEARCH_RUN_NOT_FOUND', 'Research run not found.', 404],
    'run-stale': ['RESEARCH_RUN_STALE', 'Research run changed. Refresh and review it again.', 409],
    'already-approved': ['RESEARCH_ALREADY_APPROVED', 'Research run was already approved.', 409],
    'idempotency-conflict': ['RESEARCH_IDEMPOTENCY_CONFLICT', 'Idempotency key conflicts with another approval payload.', 409],
    'selection-invalid': ['RESEARCH_SELECTION_INVALID', 'Research candidate selection is invalid.', 400],
    'run-not-approvable': ['RESEARCH_RUN_NOT_APPROVABLE', 'Research run is not awaiting approval.', 409],
    'run-not-retryable': ['RESEARCH_RUN_NOT_RETRYABLE', 'Research run cannot be retried.', 409],
    'candidate-set-conflict': ['RESEARCH_RUN_NOT_APPROVABLE', 'Stored Research evidence is invalid.', 409],
  };
  const mapping = mappings[error.code];
  if (!mapping) return error;
  const [code, message, status] = mapping;
  const includeLatest = code === 'RESEARCH_RUN_STALE'
    || code === 'RESEARCH_ALREADY_APPROVED'
    || code === 'RESEARCH_RUN_NOT_RETRYABLE';
  return new ResearchApprovalServiceError(
    code,
    message,
    status,
    includeLatest ? safelyReadLatest(runId, subjectId) : undefined,
  );
}

function safelyReadLatest(runId: string, subjectId: string): ResearchRunView | undefined {
  try {
    const stored = researchRepo.findResearchRunById(runId, subjectId);
    return stored ? mapStoredResearchRunToView(stored) : undefined;
  } catch {
    return undefined;
  }
}

function invalidStoredEvidence(): ResearchApprovalServiceError {
  return new ResearchApprovalServiceError(
    'RESEARCH_RUN_NOT_APPROVABLE',
    'Stored Research evidence is invalid.',
    409,
  );
}

function notFound(): ResearchApprovalServiceError {
  return new ResearchApprovalServiceError(
    'RESEARCH_RUN_NOT_FOUND',
    'Research run not found.',
    404,
  );
}
