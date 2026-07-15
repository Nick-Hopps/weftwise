import type {
  EnrichedLintFinding,
  Job,
  LintVerificationRequest,
} from '@/lib/contracts';
import * as queue from '../jobs/queue';
import { readRemediationContext } from './remediation-context';
import { selectLatestFindings } from './lint-latest';

export interface LintVerificationContext {
  baseline: ReturnType<typeof selectLatestFindings>;
  remediationJobs: Job[];
  request: LintVerificationRequest;
}

const SEMANTIC_FINDING_TYPES = new Set<EnrichedLintFinding['type']>([
  'contradiction',
  'missing-crossref',
  'coverage-gap',
]);
const DETERMINISTIC_FINDING_TYPES = new Set<EnrichedLintFinding['type']>([
  'broken-link',
  'orphan',
  'missing-frontmatter',
  'stale-source',
  'orphan-source',
  'thin-page',
]);

export class LintVerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LintVerificationError';
  }
}

function assertVerificationJobPair(
  subjectId: string,
  request: LintVerificationRequest,
  baselineJob: Job | null,
  remediationJob: Job | null,
): ReturnType<typeof selectLatestFindings> {
  if (
    !baselineJob
    || baselineJob.type !== 'lint'
    || baselineJob.status !== 'completed'
    || baselineJob.subjectId !== subjectId
  ) {
    throw new LintVerificationError(
      'invalid-verification-baseline',
      'Verification baseline is missing or belongs to another subject',
    );
  }
  if (
    !remediationJob
    || (remediationJob.type !== 'fix' && remediationJob.type !== 'curate')
    || remediationJob.status !== 'completed'
    || remediationJob.subjectId !== subjectId
  ) {
    throw new LintVerificationError(
      'invalid-verification-remediation',
      'Verification remediation is missing, incomplete, or belongs to another subject',
    );
  }

  const context = readRemediationContext(remediationJob);
  if (
    !context
    || context.lintJobId !== request.baselineLintJobId
    || context.action !== remediationJob.type
  ) {
    throw new LintVerificationError(
      'verification-context-mismatch',
      'Verification remediation does not belong to the requested lint baseline',
    );
  }

  const baseline = selectLatestFindings([baselineJob]);
  if (baseline.jobId !== request.baselineLintJobId) {
    throw new LintVerificationError(
      'invalid-verification-baseline',
      'Verification baseline could not be read',
    );
  }
  const baselineIds = new Set(baseline.findings.map((finding) => finding.id));
  if (context.findingIds.some((findingId) => !baselineIds.has(findingId))) {
    throw new LintVerificationError(
      'verification-finding-mismatch',
      'Verification remediation references findings outside the lint baseline',
    );
  }

  return baseline;
}

/**
 * 校验“修后验证”的基线与处置关系，并聚合同一基线下已经完成的 Fix/Curate。
 * 聚合可覆盖两个处置并发排队后分别触发验证的情况，避免后完成的验证复活先前已修复项。
 */
export function resolveLintVerificationContext(
  subjectId: string,
  request: LintVerificationRequest,
): LintVerificationContext {
  const baselineJob = queue.get(request.baselineLintJobId);
  const remediationJob = queue.get(request.remediationJobId);
  const baseline = assertVerificationJobPair(
    subjectId,
    request,
    baselineJob,
    remediationJob,
  );

  const remediationJobs = queue
    .list({ subjectId, status: 'completed' })
    .filter((job) => {
      if (job.type !== 'fix' && job.type !== 'curate') return false;
      const context = readRemediationContext(job);
      return context?.lintJobId === request.baselineLintJobId
        && context.action === job.type;
    });

  if (!remediationJobs.some((job) => job.id === request.remediationJobId)) {
    remediationJobs.push(remediationJob!);
  }

  return { baseline, remediationJobs, request };
}

function fixedFindingIds(remediationJobs: Job[]): Set<string> {
  const fixed = new Set<string>();

  for (const job of remediationJobs) {
    const context = readRemediationContext(job);
    if (!context) continue;

    let result: unknown;
    try {
      result = JSON.parse(job.resultJson ?? 'null');
    } catch {
      continue;
    }
    if (!isRecord(result) || !isRecord(result.perFindingOutcomes)) continue;

    for (const findingId of context.findingIds) {
      if (result.perFindingOutcomes[findingId] === 'fixed') fixed.add(findingId);
    }
  }

  return fixed;
}

/**
 * 修后验证只允许确定性扫描产生新 finding；语义 finding 只能来自基线且尚未确认修复。
 * 这把开放式“发现”与闭环“验证”分开，使 Fix/Curate 的自动检查单调收敛。
 */
export function reconcileVerificationFindings(
  baselineFindings: EnrichedLintFinding[],
  deterministicFindings: EnrichedLintFinding[],
  remediationJobs: Job[],
): EnrichedLintFinding[] {
  const fixed = fixedFindingIds(remediationJobs);
  const residualSemantic = baselineFindings.filter((finding) => (
    SEMANTIC_FINDING_TYPES.has(finding.type) && !fixed.has(finding.id)
  ));
  const freshDeterministic = deterministicFindings.filter((finding) => (
    DETERMINISTIC_FINDING_TYPES.has(finding.type)
  ));

  return [...freshDeterministic, ...residualSemantic];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
