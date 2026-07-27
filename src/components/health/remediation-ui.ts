import type {
  EnrichedLintFinding,
  HealthSnapshot,
  Job,
  RemediationAction,
  RemediationActionType,
  ResearchRunView,
} from '@/lib/contracts';
import type { TranslationFunction } from '@/lib/i18n/translator';

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
  /** true 表示任务仍在执行，恢复期间必须锁住同类 action。 */
  blocksAction: boolean;
}

/**
 * 每个 workflow 可恢复的 job 列表。
 *
 * 批量 Research 按主题拆成多个 job，恢复时必须拿到**全部**（Stop 要整批取消），
 * 所以这里是数组；fix/curate/re-ingest 一次只有一个，长度恒为 1。
 */
export type RecoverableHealthJobs =
  Partial<Record<ExecutableRemediationAction, RecoverableHealthJob[]>>;

export interface QueuedLintRun {
  origin: HealthOrigin;
}

type ActiveJobsResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

type ActiveJobsFetch = (url: string) => Promise<ActiveJobsResponse>;
type HealthJobCancelFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type HealthActionButtonState = 'idle' | 'starting' | 'running' | 'cancelling';

const EXECUTABLE_REMEDIATION_ACTIONS: readonly ExecutableRemediationAction[] = [
  'fix',
  'curate',
  'research',
  're-ingest',
];

export function healthActionButtonState(
  busy: boolean,
  jobId: string | null,
  cancelling: boolean,
): HealthActionButtonState {
  if (!busy) return 'idle';
  if (!jobId) return 'starting';
  return cancelling ? 'cancelling' : 'running';
}

/**
 * 处置按钮 idle 态是否禁用。
 *
 * 三个动作**互不阻塞**：worker 对非 ingest job 串行独占执行（`decideClaim`），vault 写入另有
 * vault-mutex 保护，所以点了就入队是安全的，禁用只会让用户白等。lint 运行中同样不阻塞——
 * 请求期由 `remediate` 的 409 `stale-snapshot` 守住陈旧 baseline。只有自身 in-flight
 * 才禁用，防重复提交。
 */
export function remediationButtonDisabled(input: {
  neverRun: boolean;
  targetCount: number;
  action: ExecutableRemediationAction;
  busyActions: ReadonlySet<ExecutableRemediationAction>;
  /** 刻意「接收但不使用」：调用方仍会传，单测据此守住「lint 不阻塞处置」不被改回去。 */
  lintRunning?: boolean;
}): boolean {
  return input.neverRun
    || input.targetCount === 0
    || input.busyActions.has(input.action);
}

export function blockingRecoverableActions(
  jobs: RecoverableHealthJobs,
): Set<ExecutableRemediationAction> {
  const actions = new Set<ExecutableRemediationAction>();
  for (const [action, candidates] of Object.entries(jobs) as Array<
    [ExecutableRemediationAction, RecoverableHealthJob[] | undefined]
  >) {
    if (candidates?.some((candidate) => candidate.blocksAction)) actions.add(action);
  }
  return actions;
}

export async function requestHealthJobCancel(
  jobId: string,
  request: HealthJobCancelFetch,
  t: TranslationFunction,
): Promise<'cancelled' | 'already-terminal'> {
  const response = await request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
  if (response.ok) return 'cancelled';
  if (response.status === 409) return 'already-terminal';

  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  throw new Error(
    typeof payload.error === 'string'
      ? payload.error
      : t('health.error.cancelStatus', { status: response.status }),
  );
}

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

/**
 * 恢复 in-flight 的处置 job。
 *
 * Research 保留全部 active job（批量拆分后一个主题一个 job，Stop 要整批取消）；
 * 其余 workflow 一次只有一个，沿用「createdAt 最新、同时间 id 最大」的确定性选择。
 * 快照 plan 是 active 列表短暂缺失时的兜底，已在 active 列表出现的 jobId 不重复计入。
 */
export function selectRecoverableHealthJobs(
  snapshot: Pick<HealthSnapshot, 'jobId' | 'findings' | 'remediations' | 'ranAt'>,
  activeJobs: Job[],
): RecoverableHealthJobs {
  const selected: RecoverableHealthJobs = {};
  const activeWorkflows = new Set<ExecutableRemediationAction>();
  const seenJobIds = new Set<string>();

  for (const job of activeJobs) {
    if (job.status !== 'running' && job.status !== 'pending') continue;
    const candidate = recoverableFromActiveJob(job);
    if (!candidate) continue;
    activeWorkflows.add(candidate.workflow);
    seenJobIds.add(candidate.jobId);

    if (candidate.workflow === 'research') {
      selected.research = [...(selected.research ?? []), candidate];
      continue;
    }
    const current = selected[candidate.workflow]?.[0];
    if (
      !current
      || candidate.createdAt > current.createdAt
      || (candidate.createdAt === current.createdAt && candidate.jobId > current.jobId)
    ) {
      selected[candidate.workflow] = [candidate];
    }
  }

  for (const finding of snapshot.findings) {
    const plan = snapshot.remediations[finding.id];
    if (
      !plan?.jobId
      || seenJobIds.has(plan.jobId)
      || (plan.status !== 'queued'
        && !(plan.workflow === 'research' && plan.status === 'awaiting-approval'))
    ) continue;
    const workflow = executableWorkflow(plan.workflow);
    if (!workflow) continue;
    const candidate: RecoverableHealthJob = {
      jobId: plan.jobId,
      workflow,
      source: 'remediation',
      createdAt: snapshot.ranAt ?? '',
      blocksAction: plan.status === 'queued',
    };

    if (workflow === 'research') {
      // 每个 finding 有自己的 run，多条 awaiting-approval plan 要各自恢复。
      seenJobIds.add(candidate.jobId);
      selected.research = [...(selected.research ?? []), candidate];
      continue;
    }
    if (activeWorkflows.has(workflow)) continue;
    const current = selected[workflow]?.[0];
    if (!current || candidate.jobId > current.jobId) selected[workflow] = [candidate];
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
    const context = readStrictRemediationContext(job.paramsJson);
    return {
      jobId: job.id,
      workflow: job.type,
      source: context?.action === job.type ? 'remediation' : 'manual',
      createdAt: job.createdAt,
      blocksAction: true,
    };
  }
  if (job.type === 'research') {
    const context = readStrictRemediationContext(job.paramsJson);
    return {
      jobId: job.id,
      workflow: 'research',
      source: context?.action === 'research' ? 'remediation' : 'manual',
      createdAt: job.createdAt,
      blocksAction: true,
    };
  }
  if (job.type === 'ingest' && readStrictRemediationContext(job.paramsJson)?.action === 're-ingest') {
    return {
      jobId: job.id,
      workflow: 're-ingest',
      source: 'remediation',
      createdAt: job.createdAt,
      blocksAction: true,
    };
  }
  return null;
}

function readStrictRemediationContext(
  paramsJson: string,
): { action: ExecutableRemediationAction; lintJobId: string } | null {
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
    const action = context.action === 'fix'
      || context.action === 'curate'
      || context.action === 'research'
      || context.action === 're-ingest'
      ? context.action
      : null;
    return action ? { action, lintJobId: context.lintJobId } : null;
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
  let active: QueuedLintRun | null = null;
  let pending: QueuedLintRun | null = null;
  return {
    request(origin: HealthOrigin): 'start' | 'queued' | 'ignored' {
      if (!active) {
        active = { origin };
        return 'start';
      }
      if (!isHealthOriginCurrent(active.origin, origin)) return 'ignored';
      pending = { origin };
      return 'queued';
    },
    finish(origin: HealthOrigin, currentOrigin: HealthOrigin): QueuedLintRun | null {
      if (!active || !isHealthOriginCurrent(active.origin, origin)) return null;
      active = null;
      const next = pending;
      pending = null;
      return next && isHealthOriginCurrent(next.origin, currentOrigin) ? next : null;
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

/**
 * 按传入顺序收集服务端明确允许执行该动作的稳定 ID。
 *
 * `findings` 是**必传的批量范围**，调用方传当前可见列表——工具栏批量动作必须与用户看到的
 * 一致：类型筛选生效时不能把筛掉的条目（或本地已删除来源的 orphan-source）一起提交。
 * 刻意不给默认值，否则「忘记传 = 悄悄退回全量」这类漂移会再次发生。
 */
export function actionFindingIds(
  snapshot: HealthSnapshot,
  action: RemediationActionType,
  findings: readonly Pick<EnrichedLintFinding, 'id'>[],
): string[] {
  return findings
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

export async function readDeleteSourceResult(
  response: Response,
  t: TranslationFunction,
): Promise<'deleted' | 'already-deleted'> {
  if (response.ok) return 'deleted';
  if (response.status === 404) return 'already-deleted';

  const payload = await response.json().catch(() => ({})) as { error?: unknown };
  const error = typeof payload.error === 'string' ? payload.error : null;
  if (response.status === 409 && error === 'in-flight') {
    throw new Error(t('health.error.sourceInFlight'));
  }
  if (response.status === 409 && error === 'already-referenced') {
    throw new Error(t('health.error.sourceReferenced'));
  }
  throw new Error(error ?? t('health.error.deleteSourceStatus', { status: response.status }));
}

export async function readResearchRunId(response: Response, t: TranslationFunction): Promise<string> {
  if (!response.ok) throw new Error(t('health.error.resultRequestStatus', { status: response.status }));

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(t('health.error.resultResponseInvalid'));
  }
  if (
    typeof json !== 'object'
    || json === null
    || typeof (json as { resultJson?: unknown }).resultJson !== 'string'
  ) {
    throw new Error(t('health.error.resultInvalid'));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse((json as { resultJson: string }).resultJson);
  } catch {
    throw new Error(t('health.error.resultInvalid'));
  }
  if (!isRecord(parsed) || typeof parsed.runId !== 'string' || !parsed.runId) {
    throw new Error(t('health.error.resultInvalid'));
  }
  return parsed.runId;
}

export async function readResearchRun(response: Response, t: TranslationFunction): Promise<ResearchRunView> {
  if (!response.ok) throw new Error(t('health.error.runRequestStatus', { status: response.status }));

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(t('health.error.runResponseInvalid'));
  }
  const run = isRecord(json) ? json.run : null;
  if (!isResearchRunView(run)) throw new Error(t('health.error.runInvalid'));
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
