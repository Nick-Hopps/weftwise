import type {
  HealthSnapshot,
  Job,
  LintLatestResult,
  RemediationContext,
  RemediationPlan,
  RemediationStatus,
  ResearchCandidate,
} from '@/lib/contracts';
import { readRemediationContext } from './remediation-context';
import { routeFinding } from './remediation-router';

export const MAX_REMEDIATION_JOBS = 200;

interface ContextJob {
  job: Job;
  context: RemediationContext;
}

interface FindingContextJob extends ContextJob {
  findingId: string;
}

interface RecentOutcomeEntry {
  subjectId: string;
  findingId: string;
  outcome: RemediationStatus;
}

const WRITE_SEMANTIC_STATUSES = new Set([
  'not-needed',
  'clean',
  'residual',
  'failed',
]);

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
  const latestByFinding = new Map<string, FindingContextJob>();

  for (const contextJob of contextJobs) {
    for (const findingId of contextJob.context.findingIds) {
      latestByFinding.set(
        findingKey(contextJob.job.subjectId!, findingId),
        { ...contextJob, findingId },
      );
    }
  }

  const remediations: Record<string, RemediationPlan> = {};
  const currentKeys = new Set<string>();

  for (const finding of lint.findings) {
    const key = findingKey(finding.subjectId, finding.id);
    currentKeys.add(key);

    const initial = routeFinding(finding, options);
    const related = latestByFinding.get(key);
    remediations[finding.id] = related
      ? applyCurrentJob(initial, related, lint.ranAt)
      : initial;
  }

  const recentEntries: RecentOutcomeEntry[] = [];
  const recentIdCounts = new Map<string, number>();

  for (const [key, contextJob] of latestByFinding) {
    if (currentKeys.has(key)) continue;

    const outcome = readRecentOutcome(contextJob, lint.ranAt);
    if (!outcome) continue;

    recentEntries.push({
      subjectId: contextJob.job.subjectId!,
      findingId: contextJob.findingId,
      outcome,
    });
    recentIdCounts.set(
      contextJob.findingId,
      (recentIdCounts.get(contextJob.findingId) ?? 0) + 1,
    );
  }

  const recentOutcomes: Record<string, RemediationStatus> = {};
  for (const entry of recentEntries) {
    const key = recentIdCounts.get(entry.findingId) === 1
      ? entry.findingId
      : findingKey(entry.subjectId, entry.findingId);
    recentOutcomes[key] = entry.outcome;
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
    status = researchOutcome(job.resultJson);
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
  const semanticStatus = result?.semanticStatus;
  if (
    !result
    || typeof writes !== 'number'
    || !Number.isSafeInteger(writes)
    || writes < 0
    || (result.postconditionStatus !== 'clean' && result.postconditionStatus !== 'residual')
    || typeof semanticStatus !== 'string'
    || !WRITE_SEMANTIC_STATUSES.has(semanticStatus)
  ) {
    return 'failed';
  }
  if (
    result.postconditionStatus !== 'clean'
    || semanticStatus === 'residual'
    || semanticStatus === 'failed'
  ) {
    return 'failed';
  }
  if (writes === 0) return 'skipped';
  return semanticStatus === 'not-needed' || semanticStatus === 'clean'
    ? 'fixed'
    : 'failed';
}

function researchOutcome(
  resultJson: string | null,
): 'awaiting-approval' | 'skipped' | 'failed' {
  const result = parseRecord(resultJson);
  if (!result || !Array.isArray(result.candidates)) return 'failed';
  if (result.candidates.length === 0) return 'skipped';
  return result.candidates.every(isResearchCandidate)
    ? 'awaiting-approval'
    : 'failed';
}

function isResearchCandidate(value: unknown): value is ResearchCandidate {
  if (!isRecord(value)) return false;
  return (
    typeof value.url === 'string'
    && typeof value.title === 'string'
    && typeof value.snippet === 'string'
    && (
      value.score === null
      || (
        typeof value.score === 'number'
        && Number.isInteger(value.score)
        && value.score >= 0
        && value.score <= 3
      )
    )
    && (typeof value.reason === 'string' || value.reason === null)
  );
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
