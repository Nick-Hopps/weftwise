import { getRawDb } from '../db/client';
import * as pendingActionsRepo from '../db/repos/pending-actions-repo';
import * as operationsRepo from '../db/repos/operations-repo';
import { enqueueEmbedIndex } from './embedding-enqueue';

/**
 * 在同一 SQLite IMMEDIATE 事务内完成页面审批的派生任务入队与状态收口。
 * 任一步失败都会同时回滚，action 保持 executing，交由维护流程安全重试。
 */
export function finalizeAppliedPageAction(input: {
  actionId: string;
  subjectId: string;
  nowIso: string;
}): void {
  const sqlite = getRawDb();
  const finalize = sqlite.transaction(() => {
    enqueueEmbedIndex(input.subjectId);
    const marked = pendingActionsRepo.markApplied(
      input.actionId,
      input.subjectId,
      input.nowIso,
    );
    if (!marked) {
      throw new Error('Pending action must be executing before page finalization.');
    }
  });
  finalize.immediate();
}

/**
 * History 回滚最终化：原 operation 状态、embedding 入队和 action applied 必须同进退。
 * 新的 inverse Saga operation 已在进入这里之前落地；失败时 action 保持 executing 供恢复重试。
 */
export function finalizeAppliedHistoryRevertAction(input: {
  actionId: string;
  subjectId: string;
  originalOperationId: string;
  nowIso: string;
}): void {
  const sqlite = getRawDb();
  const finalize = sqlite.transaction(() => {
    const markedOriginal = operationsRepo.markRevertedIfApplied(
      input.originalOperationId,
      input.subjectId,
    );
    if (!markedOriginal) {
      const original = operationsRepo.getById(input.originalOperationId);
      if (!original || original.subjectId !== input.subjectId || original.status !== 'reverted') {
        throw new Error('Original history operation must be applied before finalization.');
      }
    }
    enqueueEmbedIndex(input.subjectId);
    const markedAction = pendingActionsRepo.markApplied(
      input.actionId,
      input.subjectId,
      input.nowIso,
    );
    if (!markedAction) {
      throw new Error('Pending action must be executing before history finalization.');
    }
  });
  finalize.immediate();
}
