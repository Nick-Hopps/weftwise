import type { RemediationContext } from '@/lib/contracts';
import * as sourcesRepo from '../db/repos/sources-repo';
import * as jobsRepo from '../db/repos/jobs-repo';
import * as queue from '../jobs/queue';
import * as events from '../jobs/events';

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
}): { jobId: string } {
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

  const previous = jobsRepo.findLatestIngestJobForSource(
    input.subjectId,
    source.id,
  );
  if (
    previous
    && (previous.status === 'pending' || previous.status === 'running')
  ) {
    throw new SourceReingestError(
      409,
      'in-flight',
      'Source ingestion is already in flight',
    );
  }

  if (previous?.status === 'failed' && !isCancelled(previous.resultJson)) {
    const requeued = queue.requeueJobWithParams(
      previous.id,
      input.remediationContext
        ? { remediationContext: input.remediationContext }
        : {},
    );
    if (!requeued) {
      throw new SourceReingestError(
        409,
        'requeue-conflict',
        'Failed ingest job changed before retry',
      );
    }

    events.emit(
      previous.id,
      'job:retrying',
      'Manual re-ingest — resuming from checkpoint',
      { manual: true },
    );
    return { jobId: previous.id };
  }

  const created = queue.enqueue(
    'ingest',
    {
      sourceId: source.id,
      filename: source.filename,
      subjectId: input.subjectId,
      ...(input.remediationContext
        ? { remediationContext: input.remediationContext }
        : {}),
    },
    input.subjectId,
  );
  return { jobId: created.id };
}

function isCancelled(resultJson: string | null): boolean {
  if (!resultJson) return false;
  try {
    const result: unknown = JSON.parse(resultJson);
    return (
      typeof result === 'object'
      && result !== null
      && !Array.isArray(result)
      && (result as Record<string, unknown>).cancelled === true
    );
  } catch {
    return false;
  }
}
