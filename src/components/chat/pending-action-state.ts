import type { PendingActionView } from '@/lib/contracts';

/** 按 actionId 原位替换；新操作追加，避免 SSE 重放产生重复卡片。 */
export function upsertPendingAction(
  current: readonly PendingActionView[],
  next: PendingActionView,
): PendingActionView[] {
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
