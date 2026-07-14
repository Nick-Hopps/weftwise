import type {
  PendingActionPreview,
  PendingActionView,
  PreviewChangeInput,
  Subject,
} from '@/lib/contracts';
import * as conversationsRepo from '../db/repos/conversations-repo';
import * as pendingActionsRepo from '../db/repos/pending-actions-repo';
import type { PendingActionRecord } from '../db/repos/pending-actions-repo';
import {
  canonicalJson,
  hashPendingActionPayload,
  normalizePreviewInput,
} from './pending-action-payload';
import {
  planCreatePageInSubject,
  planDeletePageInSubject,
  planLinkEnsureInSubject,
  planMetadataPatchInSubject,
  planPatchPageInSubject,
  planUpdatePageInSubject,
} from './page-write';
import { planReenrich } from './reenrich-enqueue';
import { enqueueReenrich } from './reenrich-enqueue';
import {
  applyPlannedPageOperation,
  type PlannedPageOperation,
} from '../wiki/page-operation-plan';
import { finalizeAppliedPageAction } from './pending-action-finalizer';
import { finalizeAppliedHistoryRevertAction } from './pending-action-finalizer';
import {
  applyPlannedHistoryRevert,
  planHistoryRevert,
  type PlannedHistoryRevert,
} from './history-tools';
export { recoverPendingActions, maintainPendingActions } from './pending-action-maintenance';

const PENDING_TTL_MS = 30 * 60_000;

function assertNever(value: never): never {
  throw new Error(`Unhandled pending action operation: ${String(value)}`);
}

function pagePlanToPreview<T extends object>(plan: PlannedPageOperation<T>): PendingActionPreview {
  return {
    kind: 'page-change',
    preHead: plan.preHead,
    summary: plan.summary,
    affectedPages: plan.affectedPages,
    diff: plan.diff,
    warnings: plan.warnings,
  };
}

function historyPlanToPreview(plan: PlannedHistoryRevert): PendingActionPreview {
  return {
    kind: 'page-change',
    preHead: plan.preHead,
    summary: plan.summary,
    affectedPages: plan.affectedPages,
    diff: plan.diff,
    warnings: plan.warnings,
  };
}

function omitEffectiveAt<T extends { effectiveAt?: unknown }>(payload: T): Omit<T, 'effectiveAt'> {
  const result = { ...payload };
  delete result.effectiveAt;
  return result;
}

function isActionStalePreviewError(error: unknown): error is Error & {
  code: 'ACTION_STALE_PREVIEW';
} {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ACTION_STALE_PREVIEW';
}

export type PendingActionErrorCode =
  | 'ACTION_NOT_FOUND'
  | 'ACTION_EXPIRED'
  | 'ACTION_IN_PROGRESS'
  | 'ACTION_ALREADY_CONSUMED'
  | 'ACTION_STALE_PREVIEW'
  | 'ACTION_PAYLOAD_MISMATCH'
  | 'ACTION_PLAN_INVALID'
  | 'ACTION_APPLY_FAILED';

export class PendingActionError extends Error {
  constructor(
    readonly code: PendingActionErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly action?: PendingActionView,
  ) {
    super(message);
    this.name = 'PendingActionError';
  }
}

function parseError(errorJson: string | null): PendingActionView['error'] {
  if (!errorJson) return null;
  try {
    const value = JSON.parse(errorJson) as { code?: unknown; message?: unknown };
    return typeof value.code === 'string' && typeof value.message === 'string'
      ? { code: value.code, message: value.message }
      : { code: 'ACTION_APPLY_FAILED', message: 'The action failed.' };
  } catch {
    return { code: 'ACTION_APPLY_FAILED', message: 'The action failed.' };
  }
}

function recordToView(record: PendingActionRecord): PendingActionView {
  let preview: PendingActionPreview;
  try {
    preview = JSON.parse(record.previewJson) as PendingActionPreview;
  } catch {
    throw new PendingActionError('ACTION_PLAN_INVALID', 'Stored action preview is invalid.', 409);
  }
  return {
    actionId: record.id,
    conversationId: record.conversationId,
    operation: record.operation,
    status: record.status,
    expiresAt: record.expiresAt,
    operationId: record.operationId,
    jobId: record.jobId,
    error: parseError(record.errorJson),
    ...preview,
  };
}

async function planPreview(
  subject: Subject,
  input: PreviewChangeInput,
  effectiveAt: string,
): Promise<PendingActionPreview> {
  switch (input.operation) {
    case 'create': {
      const plan = await planCreatePageInSubject(subject, input.payload, effectiveAt);
      return pagePlanToPreview(plan);
    }
    case 'update': {
      const plan = await planUpdatePageInSubject(subject, input.payload, effectiveAt);
      return pagePlanToPreview(plan);
    }
    case 'patch': {
      const plan = await planPatchPageInSubject(subject, input.payload, effectiveAt);
      return pagePlanToPreview(plan);
    }
    case 'delete': {
      const plan = await planDeletePageInSubject(
        subject,
        input.payload.slug,
        effectiveAt,
      );
      return pagePlanToPreview(plan);
    }
    case 'reenrich':
      return planReenrich(subject.id, input.payload.slug);
    case 'metadata-patch':
      return pagePlanToPreview(await planMetadataPatchInSubject(
        subject,
        input.payload,
        effectiveAt,
      ));
    case 'link-ensure':
      return pagePlanToPreview(await planLinkEnsureInSubject(
        subject,
        input.payload,
        effectiveAt,
      ));
    default:
      return assertNever(input);
  }
}

export async function createPendingActionPreview(input: {
  conversationId: string;
  subject: Subject;
  input: PreviewChangeInput;
  now?: Date;
}): Promise<PendingActionView> {
  const conversation = conversationsRepo.getConversation(input.conversationId);
  if (!conversation || conversation.subjectId !== input.subject.id) {
    throw new PendingActionError('ACTION_NOT_FOUND', 'Conversation not found.', 404);
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const normalized = normalizePreviewInput(input.input, nowIso);
  const planPayload = omitEffectiveAt(normalized.payload);
  const normalizedForPlan = {
    operation: normalized.operation,
    payload: planPayload,
  } as PreviewChangeInput;
  let preview: PendingActionPreview;
  try {
    preview = await planPreview(input.subject, normalizedForPlan, nowIso);
  } catch (error) {
    throw new PendingActionError(
      'ACTION_PLAN_INVALID',
      error instanceof Error ? error.message : 'Unable to plan this action.',
      409,
    );
  }

  const payloadHash = hashPendingActionPayload({
    conversationId: input.conversationId,
    subjectId: input.subject.id,
    operation: normalized.operation,
    payload: normalized.payload,
  });
  const expiresAt = new Date(now.getTime() + PENDING_TTL_MS).toISOString();
  const record = pendingActionsRepo.createPendingAction({
    conversationId: input.conversationId,
    subjectId: input.subject.id,
    operation: normalized.operation,
    payloadJson: canonicalJson(normalized.payload),
    payloadHash,
    previewJson: JSON.stringify(preview),
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt,
  });
  return recordToView(record);
}

export async function createPendingHistoryRevertPreview(input: {
  conversationId: string;
  subject: Subject;
  operationId: string;
  now?: Date;
}): Promise<PendingActionView> {
  const conversation = conversationsRepo.getConversation(input.conversationId);
  if (!conversation || conversation.subjectId !== input.subject.id) {
    throw new PendingActionError('ACTION_NOT_FOUND', 'Conversation not found.', 404);
  }
  const operationId = input.operationId.trim();
  if (!operationId) {
    throw new PendingActionError('ACTION_PLAN_INVALID', 'Operation id is required.', 409);
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  let preview: PendingActionPreview;
  try {
    preview = historyPlanToPreview(await planHistoryRevert(input.subject, operationId));
  } catch (error) {
    throw new PendingActionError(
      'ACTION_PLAN_INVALID',
      error instanceof Error ? error.message : 'Unable to plan this history revert.',
      409,
    );
  }
  const payload = { operationId, effectiveAt: nowIso };
  const payloadHash = hashPendingActionPayload({
    conversationId: input.conversationId,
    subjectId: input.subject.id,
    operation: 'history-revert',
    payload,
  });
  const expiresAt = new Date(now.getTime() + PENDING_TTL_MS).toISOString();
  const record = pendingActionsRepo.createPendingAction({
    conversationId: input.conversationId,
    subjectId: input.subject.id,
    operation: 'history-revert',
    payloadJson: canonicalJson(payload),
    payloadHash,
    previewJson: JSON.stringify(preview),
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt,
  });
  return recordToView(record);
}

export function listPendingActions(input: {
  conversationId: string;
  subject: Subject;
  now?: Date;
}): PendingActionView[] {
  const conversation = conversationsRepo.getConversation(input.conversationId);
  if (!conversation || conversation.subjectId !== input.subject.id) {
    throw new PendingActionError('ACTION_NOT_FOUND', 'Conversation not found.', 404);
  }
  const now = input.now ?? new Date();
  pendingActionsRepo.expirePending(now.toISOString());
  return pendingActionsRepo
    .listForConversation(input.conversationId, input.subject.id)
    .map(recordToView);
}

function scopedRecord(id: string, subjectId: string): PendingActionRecord {
  const record = pendingActionsRepo.getScoped(id, subjectId);
  if (!record) throw new PendingActionError('ACTION_NOT_FOUND', 'Action not found.', 404);
  return record;
}

function assertConsumable(record: PendingActionRecord): PendingActionView | null {
  if (record.status === 'applied') return recordToView(record);
  if (record.status === 'expired') {
    throw new PendingActionError('ACTION_EXPIRED', 'Action expired.', 410);
  }
  if (record.status === 'approved' || record.status === 'executing') {
    throw new PendingActionError('ACTION_IN_PROGRESS', 'Action is already being processed.', 409);
  }
  if (record.status !== 'pending') {
    throw new PendingActionError('ACTION_ALREADY_CONSUMED', 'Action was already consumed.', 409);
  }
  return null;
}

type ReplannedAction = {
  preview: PendingActionPreview;
  pagePlan: PlannedPageOperation<object> | null;
  historyPlan: PlannedHistoryRevert | null;
  effectiveAt: string;
};

async function replanRecord(record: PendingActionRecord, subject: Subject): Promise<ReplannedAction> {
  const payload = JSON.parse(record.payloadJson) as Record<string, unknown>;
  const effectiveAt = String(payload.effectiveAt ?? '');
  if (!effectiveAt) throw new Error('Stored action is missing effectiveAt.');
  const planPayload = omitEffectiveAt(payload);
  let pagePlan: PlannedPageOperation<object> | null = null;
  switch (record.operation) {
    case 'create':
      pagePlan = await planCreatePageInSubject(subject, planPayload as never, effectiveAt);
      break;
    case 'update':
      pagePlan = await planUpdatePageInSubject(subject, planPayload as never, effectiveAt);
      break;
    case 'patch':
      pagePlan = await planPatchPageInSubject(subject, planPayload as never, effectiveAt);
      break;
    case 'delete':
      pagePlan = await planDeletePageInSubject(subject, String(payload.slug), effectiveAt);
      break;
    case 'reenrich': {
      const workflow = await planReenrich(subject.id, String(payload.slug));
      return { preview: workflow, pagePlan: null, historyPlan: null, effectiveAt };
    }
    case 'metadata-patch':
      pagePlan = await planMetadataPatchInSubject(subject, planPayload as never, effectiveAt);
      break;
    case 'link-ensure':
      pagePlan = await planLinkEnsureInSubject(subject, planPayload as never, effectiveAt);
      break;
    case 'history-revert': {
      const historyPlan = await planHistoryRevert(subject, String(payload.operationId));
      return {
        preview: historyPlanToPreview(historyPlan),
        pagePlan: null,
        historyPlan,
        effectiveAt,
      };
    }
    default:
      return assertNever(record.operation);
  }
  if (!pagePlan) throw new Error('Page action did not produce a plan.');
  return { preview: pagePlanToPreview(pagePlan), pagePlan, historyPlan: null, effectiveAt };
}

export async function approvePendingAction(input: {
  id: string; subject: Subject; now?: Date;
}): Promise<PendingActionView> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  pendingActionsRepo.expirePending(nowIso);
  const initial = scopedRecord(input.id, input.subject.id);
  const terminal = assertConsumable(initial);
  if (terminal) return terminal;

  const approved = pendingActionsRepo.claimApproval(input.id, input.subject.id, nowIso);
  if (!approved) {
    const current = scopedRecord(input.id, input.subject.id);
    const currentTerminal = assertConsumable(current);
    if (currentTerminal) return currentTerminal;
    throw new PendingActionError('ACTION_IN_PROGRESS', 'Action is already being processed.', 409);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(approved.payloadJson);
  } catch {
    pendingActionsRepo.markFailed(input.id, input.subject.id,
      JSON.stringify({ code: 'ACTION_PAYLOAD_MISMATCH', message: 'Stored action payload is invalid.' }), nowIso);
    throw new PendingActionError('ACTION_PAYLOAD_MISMATCH', 'Stored action payload is invalid.', 409);
  }
  const actualHash = hashPendingActionPayload({
    conversationId: approved.conversationId, subjectId: approved.subjectId,
    operation: approved.operation, payload,
  });
  if (actualHash !== approved.payloadHash) {
    pendingActionsRepo.markFailed(input.id, input.subject.id,
      JSON.stringify({ code: 'ACTION_PAYLOAD_MISMATCH', message: 'Stored action payload changed.' }), nowIso);
    throw new PendingActionError('ACTION_PAYLOAD_MISMATCH', 'Stored action payload changed.', 409);
  }

  let replanned: ReplannedAction;
  try {
    replanned = await replanRecord(approved, input.subject);
  } catch (error) {
    pendingActionsRepo.markFailed(input.id, input.subject.id,
      JSON.stringify({ code: 'ACTION_PLAN_INVALID', message: 'Action can no longer be planned.' }), nowIso);
    throw new PendingActionError('ACTION_PLAN_INVALID',
      error instanceof Error ? error.message : 'Action can no longer be planned.', 409);
  }

  const previousPreview = JSON.parse(approved.previewJson) as PendingActionPreview;
  if (replanned.preview.preHead !== previousPreview.preHead) {
    pendingActionsRepo.refreshPreview({
      id: input.id, subjectId: input.subject.id, payloadHash: approved.payloadHash,
      previewJson: JSON.stringify(replanned.preview),
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(), updatedAt: nowIso,
    });
    const refreshed = recordToView(scopedRecord(input.id, input.subject.id));
    throw new PendingActionError('ACTION_STALE_PREVIEW',
      'Vault changed after preview; review the refreshed action.', 409, refreshed);
  }

  const operationId = replanned.pagePlan?.changeset.id
    ?? replanned.historyPlan?.changeset.id
    ?? null;
  if (!pendingActionsRepo.claimExecution(input.id, input.subject.id, operationId, null, nowIso)) {
    throw new PendingActionError('ACTION_IN_PROGRESS', 'Action is already being processed.', 409);
  }
  if (replanned.pagePlan || replanned.historyPlan) {
    try {
      if (replanned.historyPlan) {
        await applyPlannedHistoryRevert(replanned.historyPlan);
      } else {
        await applyPlannedPageOperation(replanned.pagePlan!);
      }
    } catch (error) {
      if (isActionStalePreviewError(error)) {
        let refreshedPlan: ReplannedAction;
        try {
          refreshedPlan = await replanRecord(approved, input.subject);
        } catch (replanError) {
          pendingActionsRepo.markFailed(input.id, input.subject.id,
            JSON.stringify({ code: 'ACTION_PLAN_INVALID', message: 'Action can no longer be planned.' }), nowIso);
          throw new PendingActionError(
            'ACTION_PLAN_INVALID',
            replanError instanceof Error ? replanError.message : 'Action can no longer be planned.',
            409,
          );
        }
        const refreshed = pendingActionsRepo.refreshExecutingPreview({
          id: input.id,
          subjectId: input.subject.id,
          operationId: operationId!,
          payloadHash: approved.payloadHash,
          previewJson: JSON.stringify(refreshedPlan.preview),
          expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
          updatedAt: nowIso,
        });
        if (!refreshed) {
          throw new PendingActionError(
            'ACTION_IN_PROGRESS',
            'Action state changed while refreshing the stale preview.',
            409,
          );
        }
        const refreshedAction = recordToView(scopedRecord(input.id, input.subject.id));
        throw new PendingActionError(
          'ACTION_STALE_PREVIEW',
          'Vault changed during approval; review the refreshed action.',
          409,
          refreshedAction,
        );
      }
      pendingActionsRepo.markFailed(input.id, input.subject.id,
        JSON.stringify({ code: 'ACTION_APPLY_FAILED', message: 'Action execution failed.' }), nowIso);
      throw new PendingActionError('ACTION_APPLY_FAILED', 'Action execution failed.', 500);
    }

    try {
      if (replanned.historyPlan) {
        finalizeAppliedHistoryRevertAction({
          actionId: input.id,
          subjectId: input.subject.id,
          originalOperationId: replanned.historyPlan.originalOperationId,
          nowIso,
        });
      } else {
        finalizeAppliedPageAction({
          actionId: input.id,
          subjectId: input.subject.id,
          nowIso,
        });
      }
    } catch {
      throw new PendingActionError(
        'ACTION_IN_PROGRESS',
        'Wiki change was applied; background finalization will be retried.',
        409,
      );
    }
  } else {
    try {
      const { jobId } = enqueueReenrich(input.subject.id, String(payload && (payload as Record<string, unknown>).slug));
      pendingActionsRepo.markApplied(input.id, input.subject.id, nowIso, { jobId });
    } catch {
      pendingActionsRepo.markFailed(input.id, input.subject.id,
        JSON.stringify({ code: 'ACTION_APPLY_FAILED', message: 'Action execution failed.' }), nowIso);
      throw new PendingActionError('ACTION_APPLY_FAILED', 'Action execution failed.', 500);
    }
  }
  return recordToView(scopedRecord(input.id, input.subject.id));
}

export function rejectPendingAction(input: {
  id: string; subject: Subject; now?: Date;
}): PendingActionView {
  const nowIso = (input.now ?? new Date()).toISOString();
  pendingActionsRepo.expirePending(nowIso);
  const current = scopedRecord(input.id, input.subject.id);
  assertConsumable(current);
  if (!pendingActionsRepo.rejectPending(input.id, input.subject.id, nowIso)) {
    throw new PendingActionError('ACTION_ALREADY_CONSUMED', 'Action was already consumed.', 409);
  }
  return recordToView(scopedRecord(input.id, input.subject.id));
}
