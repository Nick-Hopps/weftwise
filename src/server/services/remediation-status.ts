import type {
  HealthSnapshot,
  Job,
  LintLatestResult,
  RemediationContext,
  RemediationPlan,
  RemediationStatus,
  ResearchCandidate,
  ResearchRunView,
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
  options: { readOnly?: boolean; researchRuns?: ResearchRunView[] } = {},
): HealthSnapshot {
  const contextJobs = [...jobs]
    .sort(compareJobs)
    .slice(-MAX_REMEDIATION_JOBS)
    .flatMap((job): ContextJob[] => {
      const context = readRemediationContext(job);
      return context && job.subjectId ? [{ job, context }] : [];
    });
  const latestByFinding = new Map<string, FindingContextJob>();
  const researchRunsByJob = new Map<string, ResearchRunView>();
  for (const run of options.researchRuns ?? []) {
    researchRunsByJob.set(researchJobKey(run.subjectId, run.researchJobId), run);
  }

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
  const visibleFindings: typeof lint.findings = [];
  const projectedOutcomes: RecentOutcomeEntry[] = [];

  for (const finding of lint.findings) {
    const key = findingKey(finding.subjectId, finding.id);
    currentKeys.add(key);

    const initial = routeFinding(finding, options);
    const related = latestByFinding.get(key);
    const plan = related
      ? applyCurrentJob(initial, related, lint.ranAt, researchRunsByJob)
      : initial;
    if (plan.status === 'fixed') {
      projectedOutcomes.push({
        subjectId: finding.subjectId,
        findingId: finding.id,
        outcome: 'fixed',
      });
      continue;
    }

    visibleFindings.push(finding);
    remediations[finding.id] = plan;
  }

  const recentEntries: RecentOutcomeEntry[] = [...projectedOutcomes];
  const recentIdCounts = new Map<string, number>();
  for (const entry of projectedOutcomes) {
    recentIdCounts.set(
      entry.findingId,
      (recentIdCounts.get(entry.findingId) ?? 0) + 1,
    );
  }

  for (const [key, contextJob] of latestByFinding) {
    if (currentKeys.has(key)) continue;

    const outcome = readRecentOutcome(contextJob, lint.ranAt, researchRunsByJob);
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

  const bySeverity = {
    critical: visibleFindings.filter((finding) => finding.severity === 'critical').length,
    warning: visibleFindings.filter((finding) => finding.severity === 'warning').length,
    info: visibleFindings.filter((finding) => finding.severity === 'info').length,
  };

  return {
    ...lint,
    findings: visibleFindings,
    bySeverity,
    remediations,
    recentOutcomes,
  };
}

function applyCurrentJob(
  plan: RemediationPlan,
  { job, context, findingId }: FindingContextJob,
  lintRanAt: string | null,
  researchRunsByJob: Map<string, ResearchRunView>,
): RemediationPlan {
  let status: RemediationStatus;

  if (job.status === 'pending' || job.status === 'running') {
    status = 'queued';
  } else if (job.status === 'failed') {
    status = 'failed';
  } else if (context.action === 'research') {
    const run = researchRunsByJob.get(researchJobKey(job.subjectId!, job.id));
    status = run
      ? researchRunOutcome(run, findingId)
      : researchOutcome(job.resultJson);
  } else if (context.action === 'fix' || context.action === 'curate') {
    if (lintRanAt === null || job.completedAt === null) {
      status = 'queued';
    } else {
      const outcome = readPerFindingOutcome(job.resultJson, findingId)
        ?? completedWriteOutcome(job.resultJson);
      // baseline 之后的任务结果由任务内 postcondition 直接收敛；更新的 lint 仍可重新发现问题。
      status = job.completedAt > lintRanAt
        ? outcome
        : outcome === 'fixed' ? 'failed' : outcome;
    }
  } else if (
    lintRanAt === null
    || job.completedAt === null
    || job.completedAt > lintRanAt
  ) {
    status = 'queued';
  } else {
    status = 'failed';
  }

  return { ...plan, status, jobId: job.id };
}

function readRecentOutcome(
  { job, context, findingId }: FindingContextJob,
  lintRanAt: string | null,
  researchRunsByJob: Map<string, ResearchRunView>,
): RemediationStatus | null {
  if (job.status === 'pending' || job.status === 'running') return null;
  if (context.action === 'research') {
    const run = researchRunsByJob.get(researchJobKey(job.subjectId!, job.id));
    if (!run) return null;
    const outcome = researchRunOutcome(run, findingId);
    return outcome === 'fixed' || outcome === 'failed' || outcome === 'skipped'
      ? outcome
      : null;
  }
  if (job.status === 'failed') return 'failed';
  if (context.action === 'fix' || context.action === 'curate') {
    if (job.completedAt === null) return null;
    return readPerFindingOutcome(job.resultJson, findingId)
      ?? completedWriteOutcome(job.resultJson);
  }
  if (
    lintRanAt === null
    || job.completedAt === null
    || job.completedAt > lintRanAt
  ) {
    return null;
  }
  if (context.action === 're-ingest') return 'fixed';

  return completedWriteOutcome(job.resultJson);
}

/** 新 Fix / Curate 优先使用目标 finding 自身结果；缺失或损坏则回退旧 job-level 逻辑。 */
function readPerFindingOutcome(
  resultJson: string | null,
  findingId: string,
): 'fixed' | 'failed' | 'skipped' | null {
  const result = parseRecord(resultJson);
  const outcomes = result?.perFindingOutcomes;
  if (!isRecord(outcomes)) return null;
  const outcome = outcomes[findingId];
  return outcome === 'fixed' || outcome === 'failed' || outcome === 'skipped'
    ? outcome
    : null;
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

function researchRunOutcome(
  run: ResearchRunView,
  findingId: string,
): RemediationStatus {
  if (run.status === 'awaiting-approval') return 'awaiting-approval';
  if (run.status === 'importing' || run.status === 'verifying') return 'queued';
  if (run.status === 'dismissed' || run.status === 'empty') return 'skipped';

  if (run.origin === 'topic') {
    return run.status === 'completed' ? 'fixed' : 'failed';
  }
  const finding = run.findings.find((item) => item.findingId === findingId);
  if (!finding) return 'failed';
  return finding.verificationStatus === 'fixed' ? 'fixed' : 'failed';
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

function researchJobKey(subjectId: string, researchJobId: string): string {
  return JSON.stringify([subjectId, researchJobId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
