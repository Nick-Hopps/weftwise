import type { PendingActionView } from '@/lib/contracts';

const ACTIVE_STATUSES = new Set<PendingActionView['status']>([
  'pending',
  'approved',
  'executing',
]);

/** API 已按新到旧排序；只恢复仍需用户或系统继续处理的工作台审批。 */
export function selectActiveTagAction(
  actions: readonly PendingActionView[],
): PendingActionView | null {
  return actions.find((action) => (
    action.operation === 'tag-batch' && ACTIVE_STATUSES.has(action.status)
  )) ?? null;
}
