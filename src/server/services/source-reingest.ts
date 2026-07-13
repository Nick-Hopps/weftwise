import type { RemediationContext } from '@/lib/contracts';
import * as sourcesRepo from '../db/repos/sources-repo';
import * as queue from '../jobs/queue';
import { contextKey, readRemediationContext } from './remediation-context';

export type SourceReingestErrorCode =
  | 'source-not-found'
  | 'already-referenced'
  | 'in-flight'
  | 'requeue-conflict';

export class SourceReingestError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: SourceReingestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceReingestError';
  }
}

/**
 * 重新摄入仍未被页面引用的 source；失败任务通过带参数补丁的原子重排续传。
 */
export function reingestOrphanSource(input: {
  subjectId: string;
  sourceId: string;
  remediationContext?: RemediationContext;
}): { jobId: string; deduplicated: boolean } {
  const source = sourcesRepo.getSource(input.sourceId);
  if (!source || source.subjectId !== input.subjectId) {
    throw new SourceReingestError(404, 'source-not-found', 'Source not found');
  }

  const unreferenced = sourcesRepo
    .listUnreferencedSources(input.subjectId)
    .some((candidate) => candidate.id === source.id);
  if (!unreferenced) {
    throw new SourceReingestError(
      409,
      'already-referenced',
      'Source is already referenced',
    );
  }

  const remediationContext = input.remediationContext;
  const result = queue.reingestSourceAtomic({
    subjectId: input.subjectId,
    sourceId: source.id,
    createParams: {
      sourceId: source.id,
      filename: source.filename,
      subjectId: input.subjectId,
      ...(remediationContext
        ? { remediationContext }
        : {}),
    },
    paramsPatch: remediationContext ? { remediationContext } : {},
    ...(remediationContext
      ? {
          isDuplicateInFlight: (job) => {
            const existing = readRemediationContext(job);
            return existing !== null
              && contextKey(input.subjectId, existing)
                === contextKey(input.subjectId, remediationContext);
          },
        }
      : {}),
  });

  if (result.kind === 'created' || result.kind === 'requeued') {
    return { jobId: result.job.id, deduplicated: false };
  }
  if (result.kind === 'in-flight') {
    if (result.deduplicated) {
      return { jobId: result.job.id, deduplicated: true };
    }
    throw new SourceReingestError(
      409,
      'in-flight',
      'Source ingestion is already in flight',
    );
  }
  throw new SourceReingestError(
    409,
    'requeue-conflict',
    'Failed ingest job changed before retry',
  );
}
