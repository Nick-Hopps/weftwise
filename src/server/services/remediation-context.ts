import type { Job, RemediationContext } from '@/lib/contracts';

const REMEDIATION_ACTIONS = new Set<RemediationContext['action']>([
  'fix',
  'curate',
  'research',
  're-ingest',
]);

export function normalizeRemediationContext(
  context: RemediationContext
): RemediationContext {
  return {
    ...context,
    findingIds: [...new Set(context.findingIds)].sort(),
  };
}

export function readRemediationContext(
  job: Pick<Job, 'paramsJson'>
): RemediationContext | null {
  try {
    const params: unknown = JSON.parse(job.paramsJson);
    if (!isRecord(params)) return null;

    const context = params.remediationContext;
    if (!isRecord(context)) return null;
    if (typeof context.lintJobId !== 'string') return null;
    if (
      !Array.isArray(context.findingIds) ||
      !context.findingIds.every((findingId) => typeof findingId === 'string')
    ) {
      return null;
    }
    if (
      typeof context.action !== 'string' ||
      !REMEDIATION_ACTIONS.has(context.action as RemediationContext['action'])
    ) {
      return null;
    }

    return normalizeRemediationContext({
      lintJobId: context.lintJobId,
      findingIds: context.findingIds,
      action: context.action as RemediationContext['action'],
    });
  } catch {
    return null;
  }
}

export function contextKey(
  subjectId: string,
  context: RemediationContext
): string {
  const normalized = normalizeRemediationContext(context);
  return [
    subjectId,
    normalized.lintJobId,
    normalized.action,
    normalized.findingIds.join(','),
  ].join('\0');
}

export function findDuplicateRemediationJob(
  jobs: Job[],
  subjectId: string,
  context: RemediationContext,
  lintRanAt: string | null
): Job | null {
  const expectedKey = contextKey(subjectId, context);
  let latest: Job | null = null;

  for (const job of jobs) {
    if (job.subjectId !== subjectId || job.status === 'failed') continue;

    const existingContext = readRemediationContext(job);
    if (!existingContext || contextKey(subjectId, existingContext) !== expectedKey) {
      continue;
    }

    const reusable =
      job.status === 'pending' ||
      job.status === 'running' ||
      (job.status === 'completed' &&
        (lintRanAt === null ||
          job.completedAt === null ||
          job.completedAt > lintRanAt));
    if (!reusable) continue;

    if (latest === null || job.createdAt > latest.createdAt) {
      latest = job;
    }
  }

  return latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
