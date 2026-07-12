import type {
  EnrichedLintFinding,
  HealthSnapshot,
  RemediationAction,
  RemediationPlan,
  RemediationStatus,
} from './contracts';

const FINDING_TYPES = new Set<EnrichedLintFinding['type']>([
  'broken-link',
  'orphan',
  'missing-frontmatter',
  'stale-source',
  'contradiction',
  'missing-crossref',
  'coverage-gap',
  'orphan-source',
  'thin-page',
]);
const FINDING_SEVERITIES = new Set<EnrichedLintFinding['severity']>([
  'critical',
  'warning',
  'info',
]);
const REMEDIATION_WORKFLOWS = new Set<RemediationPlan['workflow']>([
  'fix',
  'curate',
  'research',
  're-ingest',
  'source-review',
]);
const REMEDIATION_STATUSES = new Set<RemediationStatus>([
  'fixed',
  'queued',
  'awaiting-approval',
  'skipped',
  'failed',
]);
const ACTION_TYPES = new Set<RemediationAction['type']>([
  'fix',
  'curate',
  'research',
  're-ingest',
  'review-source',
]);

type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class HealthSnapshotRequestError extends Error {
  constructor(readonly status: number) {
    super(`Health snapshot request failed (${status})`);
    this.name = 'HealthSnapshotRequestError';
  }
}

export function parseHealthSnapshot(value: unknown): HealthSnapshot {
  if (!isRecord(value)) invalid('顶层必须是对象');
  if (!isNullableString(value.jobId)) invalid('jobId 非法');
  if (!isNullableString(value.ranAt)) invalid('ranAt 非法');
  if (!isSeverityCounts(value.bySeverity)) invalid('bySeverity 非法');
  if (
    !Array.isArray(value.findings)
    || !value.findings.every(isEnrichedLintFinding)
  ) {
    invalid('findings 非法');
  }

  const remediations = value.remediations === undefined
    ? {}
    : parseRemediations(value.remediations);
  const recentOutcomes = value.recentOutcomes === undefined
    ? {}
    : parseRecentOutcomes(value.recentOutcomes);

  return {
    jobId: value.jobId,
    ranAt: value.ranAt,
    bySeverity: value.bySeverity,
    findings: value.findings,
    remediations,
    recentOutcomes,
  };
}

export async function fetchHealthSnapshot(
  apiFetch: ApiFetch,
  path: string,
): Promise<HealthSnapshot> {
  const response = await apiFetch(path);
  if (!response.ok) throw new HealthSnapshotRequestError(response.status);
  return parseHealthSnapshot(await response.json());
}

function parseRemediations(value: unknown): Record<string, RemediationPlan> {
  if (!isRecord(value)) invalid('remediations 非法');
  for (const [findingId, plan] of Object.entries(value)) {
    if (!isRemediationPlan(plan) || plan.findingId !== findingId) {
      invalid('remediation plan 非法');
    }
  }
  return value as Record<string, RemediationPlan>;
}

function parseRecentOutcomes(value: unknown): Record<string, RemediationStatus> {
  if (!isRecord(value)) invalid('recentOutcomes 非法');
  for (const status of Object.values(value)) {
    if (!isRemediationStatus(status)) invalid('recent outcome 非法');
  }
  return value as Record<string, RemediationStatus>;
}

function isEnrichedLintFinding(value: unknown): value is EnrichedLintFinding {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.subjectId === 'string'
    && typeof value.subjectSlug === 'string'
    && typeof value.type === 'string'
    && FINDING_TYPES.has(value.type as EnrichedLintFinding['type'])
    && typeof value.severity === 'string'
    && FINDING_SEVERITIES.has(value.severity as EnrichedLintFinding['severity'])
    && typeof value.pageSlug === 'string'
    && typeof value.description === 'string'
    && isNullableString(value.suggestedFix)
    && isOptionalString(value.sourceId)
    && isOptionalString(value.sourceFilename)
    && (value.failedJobId === undefined || isNullableString(value.failedJobId))
  );
}

function isRemediationPlan(value: unknown): value is RemediationPlan {
  if (!isRecord(value)) return false;
  return (
    typeof value.findingId === 'string'
    && typeof value.workflow === 'string'
    && REMEDIATION_WORKFLOWS.has(value.workflow as RemediationPlan['workflow'])
    && isRemediationStatus(value.status)
    && Array.isArray(value.actions)
    && value.actions.every(isRemediationAction)
    && typeof value.reason === 'string'
    && isOptionalString(value.jobId)
  );
}

function isRemediationAction(value: unknown): value is RemediationAction {
  if (!isRecord(value)) return false;
  return (
    typeof value.type === 'string'
    && ACTION_TYPES.has(value.type as RemediationAction['type'])
    && typeof value.label === 'string'
    && value.destructive === false
    && isOptionalString(value.href)
  );
}

function isSeverityCounts(value: unknown): value is HealthSnapshot['bySeverity'] {
  if (!isRecord(value)) return false;
  return ['critical', 'warning', 'info'].every((key) => {
    const count = value[key];
    return Number.isSafeInteger(count) && (count as number) >= 0;
  });
}

function isRemediationStatus(value: unknown): value is RemediationStatus {
  return typeof value === 'string'
    && REMEDIATION_STATUSES.has(value as RemediationStatus);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(detail: string): never {
  throw new TypeError(`HealthSnapshot 响应无效：${detail}`);
}
