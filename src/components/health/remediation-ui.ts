import type {
  HealthSnapshot,
  Job,
  RemediationAction,
  RemediationActionType,
  ResearchCandidate,
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
    if (plan?.status !== 'queued' || !plan.jobId) continue;
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

export async function readResearchCandidates(response: Response): Promise<ResearchCandidate[]> {
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
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as { candidates?: unknown }).candidates)
  ) {
    throw new Error('Research result is invalid.');
  }
  return (parsed as { candidates: ResearchCandidate[] }).candidates;
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
