import * as operationsRepo from '../db/repos/operations-repo';
import * as pendingActionsRepo from '../db/repos/pending-actions-repo';
import { createLogger } from '../logging';
import {
  finalizeAppliedHistoryRevertAction,
  finalizeAppliedPageAction,
} from './pending-action-finalizer';

const log = createLogger('pending-action-maintenance');

export function recoverPendingActions(now = new Date()): number {
  const nowIso = now.toISOString();
  const staleBefore = now.getTime() - 5 * 60_000;
  let recovered = 0;
  for (const action of pendingActionsRepo.listRecoverable()) {
    if (action.status === 'executing' && action.operationId) {
      const operation = operationsRepo.getById(action.operationId);
      if (operation?.status === 'applied') {
        try {
          if (action.operation === 'history-revert') {
            const payload = JSON.parse(action.payloadJson) as { operationId?: unknown };
            if (typeof payload.operationId !== 'string' || !payload.operationId) {
              throw new Error('History revert action is missing the original operation id.');
            }
            finalizeAppliedHistoryRevertAction({
              actionId: action.id,
              subjectId: action.subjectId,
              originalOperationId: payload.operationId,
              nowIso,
            });
          } else {
            finalizeAppliedPageAction({
              actionId: action.id,
              subjectId: action.subjectId,
              nowIso,
            });
          }
          recovered += 1;
        } catch (error) {
          log.warn(`页面审批 ${action.id} 最终化失败，保留 executing 等待重试`, error);
        }
        continue;
      }
      if (operation && ['rolled-back', 'failed'].includes(operation.status)) {
        recovered += Number(pendingActionsRepo.markFailed(action.id, action.subjectId,
          JSON.stringify({ code: 'ACTION_APPLY_FAILED', message: 'Saga did not apply.' }), nowIso));
        continue;
      }
    }
    if (new Date(action.updatedAt).getTime() <= staleBefore) {
      recovered += Number(pendingActionsRepo.markFailed(action.id, action.subjectId,
        JSON.stringify({ code: 'ACTION_APPLY_FAILED', message: 'Action execution timed out.' }), nowIso));
    }
  }
  return recovered;
}

export function maintainPendingActions(now = new Date()): {
  expired: number; recovered: number; pruned: number;
} {
  const expired = pendingActionsRepo.expirePending(now.toISOString());
  const recovered = recoverPendingActions(now);
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const pruned = pendingActionsRepo.pruneTerminal(cutoff);
  return { expired, recovered, pruned };
}
