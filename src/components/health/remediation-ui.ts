import type {
  HealthSnapshot,
  RemediationAction,
  RemediationActionType,
} from '@/lib/contracts';

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
