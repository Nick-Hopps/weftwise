import type {
  EnrichedLintFinding,
  RemediationActionType,
  RemediationContext,
  Subject,
} from '@/lib/contracts';
import { MAX_RESEARCH_BATCH_JOBS } from '@/lib/research-plan';
import * as queue from '../jobs/queue';
import { isWebSearchConfigured } from '../search/web-search';
import { selectLatestFindings } from './lint-latest';
import {
  findDuplicateRemediationJob,
  normalizeRemediationContext,
} from './remediation-context';
import { routeFinding } from './remediation-router';
import {
  reingestOrphanSource,
  SourceReingestError,
} from './source-reingest';

export const MAX_REMEDIATION_FINDINGS = 100;

type ExecutableRemediationAction = Exclude<
  RemediationActionType,
  'review-source'
>;

const EXECUTABLE_ACTIONS = new Set<ExecutableRemediationAction>([
  'fix',
  'curate',
  'research',
  're-ingest',
]);

/**
 * 一次处置请求产生的 job 集合。Research 按主题拆分，其余动作恒为单个；
 * `deduplicated` 仅在**全部**命中既有 job 时为 true。
 */
export interface RemediationResult {
  jobIds: string[];
  deduplicated: boolean;
}

export class RemediationRequestError extends Error {
  constructor(
    readonly status: 400 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemediationRequestError';
  }
}

export async function remediate(input: {
  subject: Subject;
  lintJobId: string;
  findingIds: string[];
  action: ExecutableRemediationAction;
}): Promise<RemediationResult> {
  const lintJobId: unknown = input.lintJobId;
  if (typeof lintJobId !== 'string' || lintJobId.trim().length === 0) {
    throw new RemediationRequestError(
      400,
      'invalid-lint-job-id',
      'lintJobId must be a non-empty string',
    );
  }

  const action: unknown = input.action;
  if (
    typeof action !== 'string'
    || !EXECUTABLE_ACTIONS.has(action as ExecutableRemediationAction)
  ) {
    throw new RemediationRequestError(
      400,
      'invalid-action',
      'action must be fix, curate, research, or re-ingest',
    );
  }

  const rawFindingIds: unknown = input.findingIds;
  if (
    !Array.isArray(rawFindingIds)
    || rawFindingIds.length === 0
    || rawFindingIds.length > MAX_REMEDIATION_FINDINGS
  ) {
    throw new RemediationRequestError(
      400,
      'invalid-finding-count',
      'findingIds must contain 1-100 values',
    );
  }
  if (
    !rawFindingIds.every(
      (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id),
    )
  ) {
    throw new RemediationRequestError(
      400,
      'invalid-finding-id',
      'findingIds must be 64 character lowercase hex values',
    );
  }

  const ids = [...new Set(rawFindingIds as string[])].sort();
  const executableAction = action as ExecutableRemediationAction;
  if (
    executableAction === 'research'
    && ids.length > MAX_RESEARCH_BATCH_JOBS
  ) {
    throw new RemediationRequestError(
      400,
      'invalid-research-batch',
      `Research accepts at most ${MAX_RESEARCH_BATCH_JOBS} findings per request`,
    );
  }
  const latestLint = queue.listLatestCompletedLint(input.subject.id);
  const lint = selectLatestFindings(latestLint ? [latestLint] : []);
  if (lint.jobId !== lintJobId) {
    throw new RemediationRequestError(
      409,
      'stale-snapshot',
      'Health snapshot changed',
    );
  }

  const byId = new Map(
    lint.findings.map((finding) => [finding.id, finding]),
  );
  const findings = ids
    .map((id) => byId.get(id))
    .filter((finding): finding is EnrichedLintFinding => Boolean(finding));
  if (findings.length !== ids.length) {
    throw new RemediationRequestError(
      409,
      'stale-snapshot',
      'One or more findings are no longer current',
    );
  }

  if (
    executableAction === 're-ingest'
    && (
      ids.length !== 1
      || findings.length !== 1
      || typeof findings[0].sourceId !== 'string'
      || findings[0].sourceId.trim().length === 0
    )
  ) {
    throw new RemediationRequestError(
      400,
      'invalid-reingest-scope',
      'Re-ingest requires exactly one source finding',
    );
  }

  const actionAllowed = findings.every((finding) =>
    routeFinding(finding).actions.some(
      (candidate) => candidate.type === executableAction,
    ),
  );
  if (!actionAllowed) {
    throw new RemediationRequestError(
      400,
      'action-not-allowed',
      'The action is not valid for every selected finding',
    );
  }

  const context = normalizeRemediationContext({
    lintJobId,
    findingIds: ids,
    action: executableAction,
  });
  if (executableAction === 'fix') {
    return single(getOrCreateRemediationJob('fix', {
      subjectId: input.subject.id,
      remediationContext: context,
    }, input.subject.id, context, lint.ranAt));
  }

  if (executableAction === 'curate') {
    const slugs = [...new Set(findings.map((finding) => finding.pageSlug))]
      .sort();
    return single(getOrCreateRemediationJob('curate', {
      scope: 'pages',
      slugs,
      subjectId: input.subject.id,
      remediationContext: context,
    }, input.subject.id, context, lint.ranAt));
  }

  if (executableAction === 'research') {
    // 一个主题一个 job：整个 research 流水线的 query/候选/结果预算是按 job 分配的
    // （见 lib/research-plan.ts），合批会让靠后的主题拿不到检索。
    return researchPerFinding(input.subject.id, lintJobId, ids, lint.ranAt);
  }

  return single(reingest(input.subject, findings, context));
}

function single(
  result: { jobId: string; deduplicated: boolean },
): RemediationResult {
  return { jobIds: [result.jobId], deduplicated: result.deduplicated };
}

/**
 * 按 finding 逐个创建单主题 research job。
 *
 * 不做补偿事务：中途抛错时已创建的 job 都是合法可执行的，用户重试会经
 * `findDuplicateRemediationJob` 复用它们而不是重复排队。Web search 配置检查留在
 * per-job `beforeCreate` 里——首个创建尝试就会抛出（零 job 落库），同时保住
 * 「整批命中 duplicate 时不校验配置」的既有语义，in-flight job 不因配置变化被拒。
 */
function researchPerFinding(
  subjectId: string,
  lintJobId: string,
  ids: string[],
  lintRanAt: string | null,
): RemediationResult {
  const jobIds: string[] = [];
  let allDeduplicated = true;

  for (const findingId of ids) {
    const context = normalizeRemediationContext({
      lintJobId,
      findingIds: [findingId],
      action: 'research',
    });
    const result = getOrCreateRemediationJob('research', {
      findingIds: [findingId],
      lintJobId,
      subjectId,
      remediationContext: context,
    }, subjectId, context, lintRanAt, assertWebSearchConfigured);
    jobIds.push(result.jobId);
    if (!result.deduplicated) allDeduplicated = false;
  }

  return { jobIds, deduplicated: allDeduplicated };
}

function getOrCreateRemediationJob(
  type: 'fix' | 'curate' | 'research',
  params: Record<string, unknown>,
  subjectId: string,
  context: RemediationContext,
  lintRanAt: string | null,
  beforeCreate?: () => void,
): { jobId: string; deduplicated: boolean } {
  const result = queue.getOrCreateJobAtomic({
    type,
    params,
    subjectId,
    lintRanAt,
    matcher: (jobs) => findDuplicateRemediationJob(
      jobs,
      subjectId,
      context,
      lintRanAt,
    ),
    ...(beforeCreate ? { beforeCreate } : {}),
  });
  return { jobId: result.job.id, deduplicated: result.deduplicated };
}

function assertWebSearchConfigured(): void {
  if (!isWebSearchConfigured()) {
    throw new RemediationRequestError(
      422,
      'web-search-not-configured',
      'Web search is not configured',
    );
  }
}

function reingest(
  subject: Subject,
  findings: EnrichedLintFinding[],
  context: RemediationContext,
): { jobId: string; deduplicated: boolean } {
  try {
    const result = reingestOrphanSource({
      subjectId: subject.id,
      sourceId: findings[0].sourceId!,
      remediationContext: context,
    });
    return result;
  } catch (error) {
    if (error instanceof SourceReingestError) {
      throw new RemediationRequestError(
        error.status === 404 ? 409 : error.status,
        error.code,
        error.message,
      );
    }
    throw error;
  }
}
