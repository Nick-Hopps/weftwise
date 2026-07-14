import type {
  HealthSnapshot,
  Job,
  RemediationAction,
  RemediationActionType,
  ResearchRunView,
} from '@/lib/contracts';

export type ExecutableRemediationAction = Exclude<RemediationActionType, 'review-source'>;
export type HealthScope = 'subject' | 'all';
export interface HealthOrigin {
  generation: number;
  subjectId: string;
  scope: HealthScope;
}

export interface RecoverableHealthJob {
  jobId: string;
  workflow: ExecutableRemediationAction;
  source: 'manual' | 'remediation';
  createdAt: string;
}

type ActiveJobsResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

type ActiveJobsFetch = (url: string) => Promise<ActiveJobsResponse>;

const EXECUTABLE_REMEDIATION_ACTIONS: readonly ExecutableRemediationAction[] = [
  'fix',
  'curate',
  'research',
  're-ingest',
];

export function isHealthOriginCurrent(current: HealthOrigin, candidate: HealthOrigin): boolean {
  return current.generation === candidate.generation
    && current.subjectId === candidate.subjectId
    && current.scope === candidate.scope;
}

/** 同步 ref 门：React state 提交前也能拒绝同 action 的第二次点击。 */
export function createActionGate() {
  const active = new Map<ExecutableRemediationAction, HealthOrigin>();
  return {
    tryAcquire(action: ExecutableRemediationAction, origin: HealthOrigin): boolean {
      if (active.has(action)) return false;
      active.set(action, origin);
      return true;
    },
    release(action: ExecutableRemediationAction, origin: HealthOrigin): boolean {
      const held = active.get(action);
      if (!held || !isHealthOriginCurrent(held, origin)) return false;
      active.delete(action);
      return true;
    },
    isBusy(action: ExecutableRemediationAction): boolean {
      return active.has(action);
    },
    reset(): void {
      active.clear();
    },
  };
}

export function persistedBusyActions(
  snapshot: Pick<HealthSnapshot, 'findings' | 'remediations'>,
): Set<ExecutableRemediationAction> {
  const busy = new Set<ExecutableRemediationAction>();
  for (const finding of snapshot.findings) {
    const plan = snapshot.remediations[finding.id];
    if (plan?.status !== 'queued') continue;
    for (const action of plan.actions) {
      if (action.type !== 'review-source') busy.add(action.type);
    }
  }
  return busy;
}

/** subject 的 active jobs 首次成功 hydrate 前，所有可执行入口保持安全禁用。 */
export function activeJobsHydrationBusyActions(
  scope: HealthScope,
  subjectId: string,
  ready: boolean,
): Set<ExecutableRemediationAction> {
  return scope === 'subject' && !!subjectId && !ready
    ? new Set(EXECUTABLE_REMEDIATION_ACTIONS)
    : new Set();
}

/** 先读 pending 再读 running，覆盖轮询间 job 从 pending 被 claim 的窗口。 */
export async function fetchActiveHealthJobs(
  subjectId: string,
  request: ActiveJobsFetch,
): Promise<Job[]> {
  const encodedSubjectId = encodeURIComponent(subjectId);
  const pendingResponse = await request(
    `/api/jobs?status=pending&subjectId=${encodedSubjectId}`,
  );
  if (!pendingResponse.ok) throw new Error('Active jobs request failed');
  const pending = await pendingResponse.json();

  const runningResponse = await request(
    `/api/jobs?status=running&subjectId=${encodedSubjectId}`,
  );
  if (!runningResponse.ok) throw new Error('Active jobs request failed');
  const running = await runningResponse.json();

  return [
    ...(Array.isArray(pending) ? pending as Job[] : []),
    ...(Array.isArray(running) ? running as Job[] : []),
  ];
}

export function selectRecoverableHealthJobs(
  snapshot: Pick<HealthSnapshot, 'findings' | 'remediations' | 'ranAt'>,
  activeJobs: Job[],
): Partial<Record<ExecutableRemediationAction, RecoverableHealthJob>> {
  const selected: Partial<Record<ExecutableRemediationAction, RecoverableHealthJob>> = {};
  const activeWorkflows = new Set<ExecutableRemediationAction>();

  for (const job of activeJobs) {
    if (job.status !== 'running' && job.status !== 'pending') continue;
    const candidate = recoverableFromActiveJob(job);
    if (!candidate) continue;
    activeWorkflows.add(candidate.workflow);
    const current = selected[candidate.workflow];
    if (
      !current
      || candidate.createdAt > current.createdAt
      || (candidate.createdAt === current.createdAt && candidate.jobId > current.jobId)
    ) {
      selected[candidate.workflow] = candidate;
    }
  }

  for (const finding of snapshot.findings) {
    const plan = snapshot.remediations[finding.id];
    if (
      !plan?.jobId
      || (plan.status !== 'queued'
        && !(plan.workflow === 'research' && plan.status === 'awaiting-approval'))
    ) continue;
    const workflow = executableWorkflow(plan.workflow);
    if (!workflow || activeWorkflows.has(workflow)) continue;
    const current = selected[workflow];
    const candidate: RecoverableHealthJob = {
      jobId: plan.jobId,
      workflow,
      source: 'remediation',
      createdAt: snapshot.ranAt ?? '',
    };
    if (!current || candidate.jobId > current.jobId) selected[workflow] = candidate;
  }
  return selected;
}

export function healthTerminalInvalidationKeys(subjectId: string): string[][] {
  return [
    ['lint-latest', subjectId],
    ['health-active-jobs', subjectId],
  ];
}

function recoverableFromActiveJob(job: Job): RecoverableHealthJob | null {
  if (job.type === 'fix' || job.type === 'curate') {
    return {
      jobId: job.id,
      workflow: job.type,
      source: readStrictRemediationAction(job.paramsJson) === job.type ? 'remediation' : 'manual',
      createdAt: job.createdAt,
    };
  }
  if (job.type === 'research') {
    return {
      jobId: job.id,
      workflow: 'research',
      source: readStrictRemediationAction(job.paramsJson) === 'research' ? 'remediation' : 'manual',
      createdAt: job.createdAt,
    };
  }
  if (job.type === 'ingest' && readStrictRemediationAction(job.paramsJson) === 're-ingest') {
    return {
      jobId: job.id,
      workflow: 're-ingest',
      source: 'remediation',
      createdAt: job.createdAt,
    };
  }
  return null;
}

function readStrictRemediationAction(paramsJson: string): ExecutableRemediationAction | null {
  try {
    const params: unknown = JSON.parse(paramsJson);
    if (!isRecord(params) || !isRecord(params.remediationContext)) return null;
    const context = params.remediationContext;
    if (typeof context.lintJobId !== 'string' || !context.lintJobId) return null;
    if (
      !Array.isArray(context.findingIds)
      || context.findingIds.length === 0
      || !context.findingIds.every((id) => typeof id === 'string' && id.length > 0)
    ) return null;
    return context.action === 'fix'
      || context.action === 'curate'
      || context.action === 'research'
      || context.action === 're-ingest'
      ? context.action
      : null;
  } catch {
    return null;
  }
}

function executableWorkflow(workflow: string): ExecutableRemediationAction | null {
  return workflow === 'fix'
    || workflow === 'curate'
    || workflow === 'research'
    || workflow === 're-ingest'
    ? workflow
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createLintRerunQueue() {
  let active: HealthOrigin | null = null;
  let pending: HealthOrigin | null = null;
  return {
    request(origin: HealthOrigin): 'start' | 'queued' | 'ignored' {
      if (!active) {
        active = origin;
        return 'start';
      }
      if (!isHealthOriginCurrent(active, origin)) return 'ignored';
      pending = origin;
      return 'queued';
    },
    finish(origin: HealthOrigin, currentOrigin: HealthOrigin): HealthOrigin | null {
      if (!active || !isHealthOriginCurrent(active, origin)) return null;
      active = null;
      const next = pending;
      pending = null;
      return next && isHealthOriginCurrent(next, currentOrigin) ? next : null;
    },
    reset(): void {
      active = null;
      pending = null;
    },
  };
}

/** 只读取服务端计划；未知 finding 或 action 不在客户端推断替代动作。 */
export function actionForFinding(
  snapshot: HealthSnapshot,
  findingId: string,
  action: RemediationActionType,
): RemediationAction | null {
  return snapshot.remediations[findingId]?.actions.find((item) => item.type === action) ?? null;
}

/** 按快照 finding 顺序收集服务端明确允许执行该动作的稳定 ID。 */
export function actionFindingIds(
  snapshot: HealthSnapshot,
  action: RemediationActionType,
): string[] {
  return snapshot.findings
    .filter((finding) => actionForFinding(snapshot, finding.id, action) !== null)
    .map((finding) => finding.id);
}

/** 服务端已保证集合有界；客户端必须完整统计全部近期终态。 */
export function recentOutcomeCounts(
  snapshot: Pick<HealthSnapshot, 'recentOutcomes'>,
): { fixed: number; failed: number; skipped: number } {
  const counts = { fixed: 0, failed: 0, skipped: 0 };
  for (const status of Object.values(snapshot.recentOutcomes)) {
    if (status === 'fixed' || status === 'failed' || status === 'skipped') {
      counts[status] += 1;
    }
  }
  return counts;
}

export function summarizeFixOutcomes(value: unknown): {
  fixed: number;
  failed: number;
  skipped: number;
} {
  const summary = { fixed: 0, failed: 0, skipped: 0 };
  if (!isRecord(value)) return summary;

  if (!isRecord(value.perFindingOutcomes)) return summary;

  for (const outcome of Object.values(value.perFindingOutcomes)) {
    if (outcome === 'fixed' || outcome === 'failed' || outcome === 'skipped') {
      summary[outcome] += 1;
    }
  }
  return summary;
}

export function recentOutcomeBannerTone(
  counts: { fixed: number; failed: number; skipped: number },
): 'success' | 'warning' | 'danger' {
  if (counts.failed > 0) return 'danger';
  if (counts.skipped > 0) return 'warning';
  return 'success';
}

export function nextDeleteArmed(
  current: boolean,
  event: 'arm' | 'acting' | 'action',
): boolean {
  return event === 'arm' ? !current : false;
}

export async function readResearchRunId(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`Research result request failed (${response.status}).`);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error('Research result response is invalid.');
  }
  if (
    typeof json !== 'object'
    || json === null
    || typeof (json as { resultJson?: unknown }).resultJson !== 'string'
  ) {
    throw new Error('Research result is invalid.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse((json as { resultJson: string }).resultJson);
  } catch {
    throw new Error('Research result is invalid.');
  }
  if (!isRecord(parsed) || typeof parsed.runId !== 'string' || !parsed.runId) {
    throw new Error('Research result is invalid.');
  }
  return parsed.runId;
}

export async function readResearchRun(response: Response): Promise<ResearchRunView> {
  if (!response.ok) throw new Error(`Research run request failed (${response.status}).`);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error('Research run response is invalid.');
  }
  const run = isRecord(json) ? json.run : null;
  if (!isResearchRunView(run)) throw new Error('Research run is invalid.');
  return run;
}

export function researchApprovalBody(
  run: Pick<ResearchRunView, 'version' | 'subjectId'>,
  candidateIds: string[],
  idempotencyKey: string,
): {
  candidateIds: string[];
  expectedVersion: number;
  idempotencyKey: string;
  subjectId: string;
} {
  return {
    candidateIds: [...candidateIds],
    expectedVersion: run.version,
    idempotencyKey,
    subjectId: run.subjectId,
  };
}

export function researchBacklogPatchBody(
  status: 'researched' | 'dismissed',
  subjectId: string,
  researchJobId?: string,
): { status: 'researched' | 'dismissed'; subjectId: string; researchJobId?: string } {
  return {
    status,
    ...(researchJobId ? { researchJobId } : {}),
    subjectId,
  };
}

const RESEARCH_RUN_STATUSES = new Set([
  'awaiting-approval',
  'importing',
  'verifying',
  'completed',
  'partial',
  'failed',
  'dismissed',
  'empty',
]);

function isResearchRunView(value: unknown): value is ResearchRunView {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string'
    || !value.id
    || typeof value.subjectId !== 'string'
    || !value.subjectId
    || typeof value.researchJobId !== 'string'
    || !value.researchJobId
    || (value.origin !== 'findings' && value.origin !== 'topic')
    || typeof value.candidateSetHash !== 'string'
    || typeof value.status !== 'string'
    || !RESEARCH_RUN_STATUSES.has(value.status)
    || typeof value.version !== 'number'
    || !Number.isSafeInteger(value.version)
    || value.version < 1
    || !Array.isArray(value.findings)
    || !Array.isArray(value.candidates)
    || !Array.isArray(value.topics)
    || !value.topics.every((item) => typeof item === 'string')
    || !Array.isArray(value.queries)
    || !value.queries.every((item) => typeof item === 'string')
    || !isNullableString(value.lintJobId)
    || !isNullableString(value.topic)
    || !isNullableString(value.verificationLintJobId)
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !isNullableString(value.completedAt)
    || (value.error !== null && !isSafeError(value.error))
    || (value.approval !== null && !isResearchApproval(value.approval))
  ) return false;

  if (!value.candidates.every((candidate) => (
    isRecord(candidate)
    && typeof candidate.id === 'string'
    && typeof candidate.url === 'string'
    && typeof candidate.normalizedUrl === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.snippet === 'string'
    && (candidate.score === null || (
      typeof candidate.score === 'number'
      && Number.isInteger(candidate.score)
      && candidate.score >= 0
      && candidate.score <= 3
    ))
    && (candidate.reason === null || typeof candidate.reason === 'string')
    && typeof candidate.rank === 'number'
    && Number.isSafeInteger(candidate.rank)
    && (candidate.decision === 'pending'
      || candidate.decision === 'approved'
      || candidate.decision === 'rejected')
    && (candidate.delivery === null || isResearchDelivery(candidate.delivery))
  ))) return false;

  return value.findings.every((finding) => (
    isRecord(finding)
    && typeof finding.findingId === 'string'
    && isEnrichedFinding(finding.finding)
    && (finding.verificationStatus === 'pending'
      || finding.verificationStatus === 'fixed'
      || finding.verificationStatus === 'residual'
      || finding.verificationStatus === 'unverifiable')
    && isNullableString(finding.verifiedAt)
    && (finding.verificationFinding === null
      || isEnrichedFinding(finding.verificationFinding))
  ));
}

function isResearchApproval(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && Array.isArray(value.selectedCandidateIds)
    && value.selectedCandidateIds.every((item) => typeof item === 'string')
    && typeof value.coordinatorJobId === 'string'
    && typeof value.createdAt === 'string';
}

function isResearchDelivery(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.status === 'pending'
      || value.status === 'fetching'
      || value.status === 'queued'
      || value.status === 'running'
      || value.status === 'completed'
      || value.status === 'failed')
    && isNullableString(value.sourceId)
    && isNullableString(value.ingestJobId)
    && Array.isArray(value.operationIds)
    && value.operationIds.every((item) => typeof item === 'string')
    && Array.isArray(value.touchedPages)
    && value.touchedPages.every((page) => isRecord(page)
      && typeof page.slug === 'string'
      && (page.action === 'created' || page.action === 'updated')
      && typeof page.system === 'boolean')
    && isNullableString(value.commitSha)
    && typeof value.attemptCount === 'number'
    && Number.isSafeInteger(value.attemptCount)
    && value.attemptCount >= 0
    && isNullableString(value.completedAt)
    && (value.error === null || isSafeError(value.error))
  );
}

function isEnrichedFinding(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.subjectId === 'string'
    && typeof value.subjectSlug === 'string'
    && typeof value.type === 'string'
    && (value.severity === 'critical' || value.severity === 'warning' || value.severity === 'info')
    && typeof value.pageSlug === 'string'
    && typeof value.description === 'string'
    && isNullableString(value.suggestedFix);
}

function isSafeError(value: unknown): boolean {
  return isRecord(value)
    && typeof value.message === 'string'
    && (value.code === undefined || typeof value.code === 'string');
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}
