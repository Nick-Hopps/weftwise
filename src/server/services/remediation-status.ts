import type {
  HealthSnapshot,
  Job,
  LintLatestResult,
  RemediationContext,
  RemediationPlan,
  RemediationStatus,
} from '@/lib/contracts';
import { readRemediationContext } from './remediation-context';
import { routeFinding } from './remediation-router';

export const MAX_REMEDIATION_JOBS = 200;

interface ContextJob {
  job: Job;
  context: RemediationContext;
}

export function buildHealthSnapshot(
  lint: LintLatestResult,
  jobs: Job[],
  options: { readOnly?: boolean } = {},
): HealthSnapshot {
  const contextJobs = [...jobs]
    .sort(compareJobs)
    .slice(-MAX_REMEDIATION_JOBS)
    .flatMap((job): ContextJob[] => {
      const context = readRemediationContext(job);
      return context && job.subjectId ? [{ job, context }] : [];
    });
  const latestByFinding = new Map<string, ContextJob>();

  for (const contextJob of contextJobs) {
    for (const findingId of contextJob.context.findingIds) {
      latestByFinding.set(findingKey(contextJob.job.subjectId!, findingId), contextJob);
    }
  }

  const remediations: Record<string, RemediationPlan> = {};
  const currentKeys = new Set<string>();
  const currentIds = new Set<string>();

  for (const finding of lint.findings) {
    const key = findingKey(finding.subjectId, finding.id);
    currentKeys.add(key);
    currentIds.add(finding.id);

    const initial = routeFinding(finding, options);
    const related = latestByFinding.get(key);
    remediations[finding.id] = related
      ? applyCurrentJob(initial, related, lint.ranAt)
      : initial;
  }

  const recentOutcomes: Record<string, RemediationStatus> = {};

  for (const [key, contextJob] of latestByFinding) {
    for (const findingId of contextJob.context.findingIds) {
      if (
        key !== findingKey(contextJob.job.subjectId!, findingId)
        || currentKeys.has(key)
        || currentIds.has(findingId)
      ) {
        continue;
      }

      const outcome = readRecentOutcome(contextJob, lint.ranAt);
      if (outcome) recentOutcomes[findingId] = outcome;
    }
  }

  return { ...lint, remediations, recentOutcomes };
}

function applyCurrentJob(
  plan: RemediationPlan,
  { job, context }: ContextJob,
  lintRanAt: string | null,
): RemediationPlan {
  let status: RemediationStatus;

  if (job.status === 'pending' || job.status === 'running') {
    status = 'queued';
  } else if (job.status === 'failed') {
    status = 'failed';
  } else if (context.action === 'research') {
    status = hasResearchCandidates(job.resultJson)
      ? 'awaiting-approval'
      : 'skipped';
  } else if (
    lintRanAt === null
    || job.completedAt === null
    || job.completedAt > lintRanAt
  ) {
    status = 'queued';
  } else if (context.action === 'fix' || context.action === 'curate') {
    const outcome = completedWriteOutcome(job.resultJson);
    status = outcome === 'fixed' ? 'failed' : outcome;
  } else {
    status = 'failed';
  }

  return { ...plan, status, jobId: job.id };
}

function readRecentOutcome(
  { job, context }: ContextJob,
  lintRanAt: string | null,
): RemediationStatus | null {
  if (context.action === 'research') return null;
  if (job.status === 'pending' || job.status === 'running') return null;
  if (
    lintRanAt === null
    || job.completedAt === null
    || job.completedAt > lintRanAt
  ) {
    return null;
  }
  if (job.status === 'failed') return 'failed';
  if (context.action === 're-ingest') return 'fixed';

  return completedWriteOutcome(job.resultJson);
}

function completedWriteOutcome(resultJson: string | null): RemediationStatus {
  const result = parseRecord(resultJson);
  const writes = result?.writes;
  if (
    !result
    || typeof writes !== 'number'
    || !Number.isInteger(writes)
    || writes < 0
    || (result.postconditionStatus !== 'clean' && result.postconditionStatus !== 'residual')
  ) {
    return 'failed';
  }
  if (
    result.postconditionStatus !== 'clean'
    || result.semanticStatus === 'residual'
    || result.semanticStatus === 'failed'
  ) {
    return 'failed';
  }
  if (writes === 0) return 'skipped';
  return result.semanticStatus === 'not-needed' || result.semanticStatus === 'clean'
    ? 'fixed'
    : 'failed';
}

function hasResearchCandidates(resultJson: string | null): boolean {
  const result = parseRecord(resultJson);
  return Array.isArray(result?.candidates) && result.candidates.length > 0;
}

function parseRecord(resultJson: string | null): Record<string, unknown> | null {
  if (!resultJson) return null;
  try {
    const value: unknown = JSON.parse(resultJson);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function compareJobs(left: Job, right: Job): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function findingKey(subjectId: string, findingId: string): string {
  return JSON.stringify([subjectId, findingId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
