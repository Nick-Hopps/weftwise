import type { Job, ResearchCandidateIngestStatus } from '@/lib/contracts';
import { describeErrorMessage } from '@/lib/error-format';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as researchRepo from '../db/repos/research-provenance-repo';
import { registerHandler } from '../jobs/worker';
import {
  acquireSubjectWriteLease,
  persistSourceAndEnqueueIngest,
} from '../sources/source-ingest-transaction';
import {
  canonicalizeResearchSelection,
  validateStoredResearchCandidates,
} from './research-provenance';

const DELIVERY_LEASE_MS = 60_000;
const PARAM_KEYS = new Set(['runId', 'approvalId', 'subjectId']);
const SENSITIVE_ERROR_PATTERN = /(?:https?:\/\/|file:\/\/|\/(?:Users|home|private|var|etc)\/|[a-z]:\\|bearer\s+|sk-[a-z0-9_-]+|(?:api[-_ ]?key|token|authorization|password|credential)\s*[:=])/i;

interface ResearchImportParams {
  runId: string;
  approvalId: string;
  subjectId: string;
}

type Emit = (
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

export interface ResearchImportDependencies {
  /** @deprecated URL 抓取已由 child ingest worker 负责；保留测试/调用签名兼容。 */
  fetchUrlSource?: (url: string) => Promise<{ filename: string; content: string }>;
}

export interface ResearchImportResult extends Record<string, unknown> {
  deliveries: Array<{
    candidateId: string;
    status: ResearchCandidateIngestStatus;
    sourceId: string | null;
    ingestJobId: string | null;
  }>;
}

export async function runResearchImportJob(
  job: Job,
  emit: Emit,
  _dependencies: ResearchImportDependencies = {},
): Promise<ResearchImportResult> {
  void _dependencies;
  const params = parseResearchImportParams(job);
  const stored = researchRepo.findResearchRunById(params.runId, params.subjectId);
  if (
    !stored
    || !stored.approval
    || stored.approval.id !== params.approvalId
    || stored.approval.coordinatorJobId !== job.id
  ) {
    throw new Error('Research import params do not match the persisted approval');
  }

  const subject = subjectsRepo.getById(params.subjectId);
  if (!subject) throw new Error('Research import subject no longer exists');
  const snapshots = validateStoredResearchCandidates(
    stored.run.id,
    stored.run.candidateSetHash,
    stored.candidates,
  );
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const selectedIds = parseSelectedCandidateIds(stored.approval.selectedCandidateIdsJson);
  const deliveriesById = new Map(stored.deliveries.map((delivery) => [delivery.candidateId, delivery]));
  if (
    selectedIds.some((candidateId) => {
      const candidate = stored.candidates.find((row) => row.id === candidateId);
      const delivery = deliveriesById.get(candidateId);
      return !candidate
        || candidate.decision !== 'approved'
        || candidate.approvalId !== params.approvalId
        || !delivery
        || delivery.approvalId !== params.approvalId
        || delivery.runId !== params.runId
        || delivery.normalizedUrl !== candidate.normalizedUrl;
    })
    || stored.deliveries.length !== selectedIds.length
  ) {
    throw new Error('Research import approval evidence is inconsistent');
  }

  emit('research-import:start', '开始调度已批准的 Research 候选', {
    runId: params.runId,
    candidateCount: selectedIds.length,
  });
  for (const candidateId of selectedIds) {
    const snapshot = snapshotsById.get(candidateId);
    if (!snapshot) throw new Error('Research import candidate snapshot is missing');
    const claim = researchRepo.claimResearchDelivery({
      approvalId: params.approvalId,
      candidateId,
      leaseMs: DELIVERY_LEASE_MS,
    });
    if (!claim) continue;

    try {
      if (claim.sourceId && !claim.ingestJobId) {
        const child = researchRepo.enqueueResearchDeliveryFromSourceAtomic({
          runId: params.runId,
          subjectId: params.subjectId,
          approvalId: params.approvalId,
          candidateId,
          claimToken: claim.claimToken!,
          sourceId: claim.sourceId,
        });
        emit('research-import:queued', 'Research 候选已从现有来源恢复 Ingest 队列', {
          candidateId,
          sourceId: claim.sourceId,
          ingestJobId: child.id,
          recovered: true,
        });
        continue;
      }

      emit('research-import:linking', '正在创建 Research URL Source', { candidateId });
      const lease = acquireSubjectWriteLease(subject.id);
      const claimToken = claim.claimToken!;
      const renewed = researchRepo.renewResearchDeliveryClaim({
        approvalId: params.approvalId,
        candidateId,
        claimToken,
        leaseMs: DELIVERY_LEASE_MS,
      });
      if (!renewed) {
        emit('research-import:claim-lost', 'Research 候选租约已失效', { candidateId });
        continue;
      }

      const persisted = persistSourceAndEnqueueIngest({
        kind: 'url',
        subject,
        lease,
        url: snapshot.normalizedUrl,
        jobParams: {
          researchProvenance: {
            runId: params.runId,
            approvalId: params.approvalId,
            candidateId,
          },
        },
        transactionHooks: {
          beforePersist: (sqlite) => {
            researchRepo.assertResearchDeliveryClaimInTransaction(sqlite, {
              approvalId: params.approvalId,
              candidateId,
              claimToken,
            });
          },
          afterEnqueue: (sqlite, result) => {
            researchRepo.markResearchDeliveryQueuedInTransaction(sqlite, {
              approvalId: params.approvalId,
              candidateId,
              claimToken,
              sourceId: result.sourceId,
              ingestJobId: result.job.id,
            });
          },
        },
      });
      emit('research-import:queued', 'Research 候选已进入 Ingest 队列', {
        candidateId,
        sourceId: persisted.sourceId,
        ingestJobId: persisted.job.id,
      });
    } catch (error) {
      const failed = researchRepo.failResearchDeliveryClaim({
        approvalId: params.approvalId,
        candidateId,
        claimToken: claim.claimToken!,
        error: safeImportError(error),
      });
      emit('research-import:candidate-failed', 'Research 候选导入失败', {
        candidateId,
        recorded: failed,
      });
    }
  }

  const latest = researchRepo.findResearchRunById(params.runId, params.subjectId);
  if (!latest) throw new Error('Research run disappeared after import coordination');
  return {
    deliveries: latest.deliveries.map((delivery) => ({
      candidateId: delivery.candidateId,
      status: delivery.status,
      sourceId: delivery.sourceId,
      ingestJobId: delivery.ingestJobId,
    })),
  };
}

function parseResearchImportParams(job: Job): ResearchImportParams {
  if (job.type !== 'research-import') throw new Error('Research import handler received another job type');
  let value: unknown;
  try {
    value = JSON.parse(job.paramsJson);
  } catch {
    throw new Error('Research import params are not valid JSON');
  }
  if (!isRecord(value)) throw new Error('Research import params must be an object');
  const keys = Object.keys(value);
  if (keys.some((key) => !PARAM_KEYS.has(key)) || keys.length !== PARAM_KEYS.size) {
    throw new Error('Research import params contain unknown or missing fields');
  }
  if (![value.runId, value.approvalId, value.subjectId].every(isNonEmptyString)) {
    throw new Error('Research import params require runId, approvalId and subjectId');
  }
  if (!job.subjectId || value.subjectId !== job.subjectId) {
    throw new Error('Research import params subjectId does not match job subject');
  }
  return value as unknown as ResearchImportParams;
}

function parseSelectedCandidateIds(json: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Research approval selection is invalid');
  }
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new Error('Research approval selection is invalid');
  }
  const canonical = canonicalizeResearchSelection(value);
  if (canonical.length !== value.length || canonical.some((id, index) => id !== value[index])) {
    throw new Error('Research approval selection is not canonical');
  }
  return canonical;
}

function safeImportError(error: unknown): { code: string; message: string } {
  const message = describeErrorMessage(error);
  return {
    code: 'RESEARCH_CANDIDATE_IMPORT_FAILED',
    message: !message || SENSITIVE_ERROR_PATTERN.test(message)
      ? 'Candidate import failed.'
      : message.slice(0, 500),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

registerHandler('research-import', async (job, emit) => runResearchImportJob(job, emit));
