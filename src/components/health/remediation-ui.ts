import type {
  HealthSnapshot,
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
