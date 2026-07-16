import type { PendingActionView } from '@/lib/contracts';

const CLOSED_STATUSES = new Set<PendingActionView['status']>([
  'applied',
  'rejected',
  'expired',
]);

/** 按 actionId 合并；已消费终态移除卡片，新操作追加以避免 SSE 重放重复。 */
export function upsertPendingAction(
  current: readonly PendingActionView[],
  next: PendingActionView,
): PendingActionView[] {
  if (CLOSED_STATUSES.has(next.status)) {
    return current.filter((action) => action.actionId !== next.actionId);
  }
  const index = current.findIndex((action) => action.actionId === next.actionId);
  if (index === -1) return [...current, next];
  const updated = [...current];
  updated[index] = next;
  return updated;
}

/** 用服务端快照替换当前会话列表；重复 id 取最后状态但保留首次出现位置。 */
export function replacePendingActions(next: readonly PendingActionView[]): PendingActionView[] {
  return next.reduce<PendingActionView[]>(
    (current, action) => upsertPendingAction(current, action),
    [],
  );
}
