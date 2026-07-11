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
  planPatchPageInSubject,
  planUpdatePageInSubject,
} from './page-write';
import { planReenrich } from './reenrich-enqueue';

const PENDING_TTL_MS = 30 * 60_000;

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
      return { kind: 'page-change', preHead: plan.preHead, summary: plan.summary,
        affectedPages: plan.affectedPages, diff: plan.diff, warnings: plan.warnings };
    }
    case 'update': {
      const plan = await planUpdatePageInSubject(subject, input.payload, effectiveAt);
      return { kind: 'page-change', preHead: plan.preHead, summary: plan.summary,
        affectedPages: plan.affectedPages, diff: plan.diff, warnings: plan.warnings };
    }
    case 'patch': {
      const plan = await planPatchPageInSubject(subject, input.payload, effectiveAt);
      return { kind: 'page-change', preHead: plan.preHead, summary: plan.summary,
        affectedPages: plan.affectedPages, diff: plan.diff, warnings: plan.warnings };
    }
    case 'delete': {
      const plan = await planDeletePageInSubject(
        subject,
        input.payload.slug,
        effectiveAt,
      );
      return { kind: 'page-change', preHead: plan.preHead, summary: plan.summary,
        affectedPages: plan.affectedPages, diff: plan.diff, warnings: plan.warnings };
    }
    case 'reenrich':
      return planReenrich(subject.id, input.payload.slug);
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
  const normalizedForPlan = {
    operation: normalized.operation,
    payload: normalized.payload,
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
