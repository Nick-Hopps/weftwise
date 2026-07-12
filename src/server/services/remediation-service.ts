import type {
  EnrichedLintFinding,
  RemediationActionType,
  RemediationContext,
  Subject,
} from '@/lib/contracts';
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
}): Promise<{ jobId: string; deduplicated: boolean }> {
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
  const lint = selectLatestFindings(
    queue.list({
      type: 'lint',
      status: 'completed',
      subjectId: input.subject.id,
    }),
  );
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
    return getOrCreateRemediationJob('fix', {
      subjectId: input.subject.id,
      remediationContext: context,
    }, input.subject.id, context, lint.ranAt);
  }

  if (executableAction === 'curate') {
    const slugs = [...new Set(findings.map((finding) => finding.pageSlug))]
      .sort();
    return getOrCreateRemediationJob('curate', {
      scope: 'pages',
      slugs,
      subjectId: input.subject.id,
      remediationContext: context,
    }, input.subject.id, context, lint.ranAt);
  }

  if (executableAction === 'research') {
    return getOrCreateRemediationJob('research', {
      findingIds: ids,
      lintJobId,
      subjectId: input.subject.id,
      remediationContext: context,
    }, input.subject.id, context, lint.ranAt, assertWebSearchConfigured);
  }

  return reingest(input.subject, findings, context);
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
