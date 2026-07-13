import { getRawDb } from '../db/client';
import * as pendingActionsRepo from '../db/repos/pending-actions-repo';
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
