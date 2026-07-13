import type {
  EnrichedLintFinding,
  Job,
  ResearchTouchedPage,
} from '@/lib/contracts';
import { describeErrorMessage } from '@/lib/error-format';
import * as pagesRepo from '../db/repos/pages-repo';
import * as operationsRepo from '../db/repos/operations-repo';
import type { OperationRow } from '../db/repos/operations-repo';
import * as researchRepo from '../db/repos/research-provenance-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as queue from '../jobs/queue';
import { buildPostconditionScope } from './operation-scope-collector';
import { selectLatestFindings } from './lint-latest';
import {
  parseResearchFindingSnapshot,
  researchFindingSnapshot,
} from './research-provenance';

const TERMINAL_DELIVERY = new Set(['completed', 'failed']);
const SAFE_ERROR_LIMIT = 500;
const SENSITIVE_ERROR_PATTERN = /(?:https?:\/\/|file:\/\/|\/(?:Users|home|private|var|etc)\/|[a-z]:\\|bearer\s+|sk-[a-z0-9_-]+|(?:api[-_ ]?key|token|authorization|password|credential)\s*[:=])/i;

export interface MaterializedIngestProvenance {
  operationIds: string[];
  touchedPages: ResearchTouchedPage[];
  commitSha: string | null;
}

/**
 * Ingest result 是页面动作首选来源；缺失或损坏时才从已应用 operation 回退。
 * operation IDs 与 postHead 无论哪条路径都保留为审计证据。
 */
export function materializeIngestProvenance(
  job: Job,
  subject: { id: string; slug: string },
  operations: OperationRow[],
  metaPageKeys: Set<string>,
): MaterializedIngestProvenance {
  const operationIds = [...new Set(operations.map((row) => row.id))].sort();
  const result = parseIngestResult(job.resultJson);
  let created: string[];
  let updated: string[];
  if (result) {
    created = result.pagesCreated;
    updated = result.pagesUpdated;
  } else {
    const scope = buildPostconditionScope(job.id, subject, operations);
    created = scope.createdSlugs;
    updated = scope.updatedSlugs;
  }

  const createdSet = new Set(created.filter(Boolean));
  const updatedSet = new Set(updated.filter((slug) => slug && !createdSet.has(slug)));
  const touchedPages: ResearchTouchedPage[] = [
    ...[...createdSet].map((slug) => ({
      slug,
      action: 'created' as const,
      system: metaPageKeys.has(pagesRepo.metaKey(subject.id, slug)),
    })),
    ...[...updatedSet].map((slug) => ({
      slug,
      action: 'updated' as const,
      system: metaPageKeys.has(pagesRepo.metaKey(subject.id, slug)),
    })),
  ].sort((left, right) => left.slug.localeCompare(right.slug));
  const operationCommit = [...operations]
    .reverse()
    .find((row) => row.postHead)?.postHead ?? null;
  return {
    operationIds,
    touchedPages,
    commitSha: result?.commitSha ?? operationCommit,
  };
}

/** 对账单个 run；所有步骤幂等，可由终态 hook、启动恢复和维护 tick 重复调用。 */
export function reconcileResearchRun(runId: string): void {
  let stored = researchRepo.findResearchRunById(runId);
  if (!stored || !['importing', 'verifying'].includes(stored.run.status)) return;

  const coordinator = stored.approval ? queue.get(stored.approval.coordinatorJobId) : null;
  if (coordinator?.status === 'failed') {
    researchRepo.failUnscheduledResearchDeliveries(runId, {
      code: 'RESEARCH_COORDINATOR_FAILED',
      message: 'Research import coordinator did not schedule this candidate.',
    });
  }

  const subject = subjectsRepo.getById(stored.run.subjectId);
  if (!subject) {
    researchRepo.failUnscheduledResearchDeliveries(runId, {
      code: 'RESEARCH_SUBJECT_MISSING',
      message: 'Research subject no longer exists.',
    });
    return;
  }

  for (const delivery of stored.deliveries) {
    if (!delivery.ingestJobId || !['queued', 'running'].includes(delivery.status)) continue;
    const child = queue.get(delivery.ingestJobId);
    if (!child || child.type !== 'ingest' || child.subjectId !== stored.run.subjectId) {
      researchRepo.failResearchDeliveryFromJob(
        delivery.approvalId,
        delivery.candidateId,
        delivery.ingestJobId,
        { code: 'RESEARCH_CHILD_MISSING', message: 'Research child ingest is unavailable.' },
      );
      continue;
    }
    if (child.status === 'pending') continue;
    if (child.status === 'running') {
      researchRepo.markResearchDeliveryRunning(
        delivery.approvalId,
        delivery.candidateId,
        child.id,
      );
      continue;
    }
    if (child.status === 'failed') {
      researchRepo.failResearchDeliveryFromJob(
        delivery.approvalId,
        delivery.candidateId,
        child.id,
        safeJobError(child, 'RESEARCH_INGEST_FAILED', 'Research child ingest failed.'),
      );
      continue;
    }

    const operations = operationsRepo.listAppliedForJob(child.id, subject.id);
    let evidence: MaterializedIngestProvenance;
    try {
      evidence = materializeIngestProvenance(
        child,
        subject,
        operations,
        pagesRepo.getMetaPageKeys(subject.id),
      );
    } catch {
      evidence = {
        operationIds: [...new Set(operations.map((operation) => operation.id))].sort(),
        touchedPages: [],
        commitSha: [...operations].reverse().find((operation) => operation.postHead)?.postHead ?? null,
      };
    }
    if (!delivery.sourceId) {
      researchRepo.failResearchDeliveryFromJob(
        delivery.approvalId,
        delivery.candidateId,
        child.id,
        { code: 'RESEARCH_SOURCE_MISSING', message: 'Research delivery source is unavailable.' },
      );
      continue;
    }
    researchRepo.completeResearchDeliveryAtomic({
      approvalId: delivery.approvalId,
      candidateId: delivery.candidateId,
      ingestJobId: child.id,
      sourceId: delivery.sourceId,
      ...evidence,
    });
  }

  stored = researchRepo.findResearchRunById(runId);
  if (!stored || !stored.deliveries.every((delivery) => TERMINAL_DELIVERY.has(delivery.status))) return;
  if (stored.run.origin === 'topic') {
    researchRepo.finalizeTopicResearchRunAtomic(runId);
    return;
  }

  const completedCount = stored.deliveries.filter((delivery) => delivery.status === 'completed').length;
  if (completedCount === 0) {
    researchRepo.failFindingResearchRunWithoutDelivery(runId);
    return;
  }
  if (!stored.run.verificationLintJobId) {
    researchRepo.enqueueResearchVerificationLintAtomic(runId);
    return;
  }

  const verification = queue.get(stored.run.verificationLintJobId);
  if (!verification || !['completed', 'failed'].includes(verification.status)) return;
  if (verification.status === 'failed') {
    researchRepo.finalizeResearchVerificationAtomic(
      runId,
      verification.id,
      stored.findings.map((finding) => ({
        findingId: finding.findingId,
        status: 'unverifiable',
        snapshot: null,
      })),
      'failed',
      safeJobError(verification, 'RESEARCH_VERIFICATION_FAILED', 'Research verification lint failed.'),
    );
    return;
  }

  const verificationFindings = parseVerificationFindings(verification);
  if (!verificationFindings) {
    researchRepo.finalizeResearchVerificationAtomic(
      runId,
      verification.id,
      stored.findings.map((finding) => ({
        findingId: finding.findingId,
        status: 'unverifiable',
        snapshot: null,
      })),
      'failed',
      { code: 'RESEARCH_VERIFICATION_INVALID', message: 'Research verification result is invalid.' },
    );
    return;
  }

  const outcomes = stored.findings.map((finding) => {
    const original = parseResearchFindingSnapshot(JSON.parse(finding.snapshotJson));
    const match = verificationFindings.find((candidate) => (
      candidate.id === finding.findingId
      || remediationLocus(candidate) === remediationLocus({
        ...original,
        subjectId: stored!.run.subjectId,
      })
    ));
    return {
      findingId: finding.findingId,
      status: match ? 'residual' as const : 'fixed' as const,
      snapshot: match ? researchFindingSnapshot(match) : null,
    };
  });
  const hasResidual = outcomes.some((outcome) => outcome.status === 'residual');
  const hasDeliveryFailure = stored.deliveries.some((delivery) => delivery.status === 'failed');
  researchRepo.finalizeResearchVerificationAtomic(
    runId,
    verification.id,
    outcomes,
    hasResidual || hasDeliveryFailure ? 'partial' : 'completed',
    null,
  );
}

/** worker 终态 hook 的精确对账入口。 */
export function reconcileResearchProvenanceForJob(jobId: string): void {
  for (const runId of researchRepo.findResearchRunIdsByJobId(jobId)) {
    reconcileResearchRun(runId);
  }
}

/** worker 启动与维护 tick 的有界恢复入口。 */
export function reconcileResearchProvenance(limit = 100): number {
  const runIds = researchRepo.listResearchRunIdsForReconciliation(limit);
  for (const runId of runIds) reconcileResearchRun(runId);
  return runIds.length;
}

function parseIngestResult(json: string | null): {
  pagesCreated: string[];
  pagesUpdated: string[];
  commitSha: string | null;
} | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value)) return null;
    if (!isStringArray(value.pagesCreated) || !isStringArray(value.pagesUpdated)) return null;
    if (value.commitSha !== undefined && typeof value.commitSha !== 'string') return null;
    return {
      pagesCreated: value.pagesCreated,
      pagesUpdated: value.pagesUpdated,
      commitSha: typeof value.commitSha === 'string' && value.commitSha ? value.commitSha : null,
    };
  } catch {
    return null;
  }
}

function parseVerificationFindings(job: Job): EnrichedLintFinding[] | null {
  try {
    const raw: unknown = JSON.parse(job.resultJson ?? 'null');
    if (!isRecord(raw) || !Array.isArray(raw.findings)) return null;
    const selected = selectLatestFindings([job]);
    return selected.findings.length === raw.findings.length ? selected.findings : null;
  } catch {
    return null;
  }
}

function remediationLocus(
  finding: Pick<EnrichedLintFinding, 'subjectId' | 'type' | 'pageSlug' | 'sourceId' | 'sourceFilename'>,
): string {
  return [
    finding.subjectId,
    finding.type,
    finding.pageSlug,
    finding.sourceId ?? finding.sourceFilename ?? '',
  ].join('\0');
}

function safeJobError(job: Job, code: string, fallback: string): { code: string; message: string } {
  let message = '';
  try {
    const value: unknown = JSON.parse(job.resultJson ?? 'null');
    if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') {
      message = value.error.message;
    }
  } catch {
    // 损坏结果统一降级。
  }
  if (!message) message = describeErrorMessage(new Error(fallback));
  return {
    code,
    message: SENSITIVE_ERROR_PATTERN.test(message) ? fallback : message.slice(0, SAFE_ERROR_LIMIT),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}
