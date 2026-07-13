import { getRawDb } from '../client';
import type { PendingActionOperation, PendingActionStatus } from '@/lib/contracts';

export interface PendingActionRecord {
  id: string;
  conversationId: string;
  subjectId: string;
  operation: PendingActionOperation;
  payloadJson: string;
  payloadHash: string;
  previewJson: string;
  status: PendingActionStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  approvedAt: string | null;
  appliedAt: string | null;
  operationId: string | null;
  jobId: string | null;
  errorJson: string | null;
}

interface RawPendingAction {
  id: string;
  conversation_id: string;
  subject_id: string;
  operation: PendingActionOperation;
  payload_json: string;
  payload_hash: string;
  preview_json: string;
  status: PendingActionStatus;
  created_at: string;
  updated_at: string;
  expires_at: string;
  approved_at: string | null;
  applied_at: string | null;
  operation_id: string | null;
  job_id: string | null;
  error_json: string | null;
}

export interface CreatePendingActionInput {
  id?: string;
  conversationId: string;
  subjectId: string;
  operation: PendingActionOperation;
  payloadJson: string;
  payloadHash: string;
  previewJson: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

const SELECT_COLUMNS = `
  id, conversation_id, subject_id, operation, payload_json, payload_hash,
  preview_json, status, created_at, updated_at, expires_at, approved_at,
  applied_at, operation_id, job_id, error_json
`;

function mapRow(row: RawPendingAction): PendingActionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    subjectId: row.subject_id,
    operation: row.operation,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    previewJson: row.preview_json,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    appliedAt: row.applied_at,
    operationId: row.operation_id,
    jobId: row.job_id,
    errorJson: row.error_json,
  };
}

export function createPendingAction(input: CreatePendingActionInput): PendingActionRecord {
  const id = input.id ?? crypto.randomUUID();
  getRawDb().prepare(
    `INSERT INTO pending_actions (
       id, conversation_id, subject_id, operation, payload_json, payload_hash,
       preview_json, status, created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.subjectId,
    input.operation,
    input.payloadJson,
    input.payloadHash,
    input.previewJson,
    input.createdAt,
    input.updatedAt,
    input.expiresAt,
  );
  return getScoped(id, input.subjectId)!;
}

export function getScoped(id: string, subjectId: string): PendingActionRecord | null {
  const row = getRawDb().prepare(
    `SELECT ${SELECT_COLUMNS} FROM pending_actions WHERE id = ? AND subject_id = ?`,
  ).get(id, subjectId) as RawPendingAction | undefined;
  return row ? mapRow(row) : null;
}

export function listForConversation(
  conversationId: string,
  subjectId: string,
): PendingActionRecord[] {
  const rows = getRawDb().prepare(
    `SELECT ${SELECT_COLUMNS} FROM pending_actions
     WHERE conversation_id = ? AND subject_id = ?
     ORDER BY created_at DESC, rowid DESC`,
  ).all(conversationId, subjectId) as RawPendingAction[];
  return rows.map(mapRow);
}

export function listRecoverable(): PendingActionRecord[] {
  const rows = getRawDb().prepare(
    `SELECT ${SELECT_COLUMNS} FROM pending_actions
     WHERE status IN ('approved','executing') ORDER BY updated_at ASC, rowid ASC`,
  ).all() as RawPendingAction[];
  return rows.map(mapRow);
}

export function claimApproval(
  id: string,
  subjectId: string,
  nowIso: string,
): PendingActionRecord | null {
  const result = getRawDb().prepare(
    `UPDATE pending_actions
     SET status = 'approved', approved_at = ?, updated_at = ?, error_json = NULL
     WHERE id = ? AND subject_id = ? AND status = 'pending' AND expires_at > ?`,
  ).run(nowIso, nowIso, id, subjectId, nowIso);
  return result.changes === 1 ? getScoped(id, subjectId) : null;
}

export function claimExecution(
  id: string,
  subjectId: string,
  operationId: string | null,
  jobId: string | null,
  nowIso: string,
): boolean {
  const result = getRawDb().prepare(
    `UPDATE pending_actions
     SET status = 'executing', operation_id = ?, job_id = ?, updated_at = ?
     WHERE id = ? AND subject_id = ? AND status = 'approved'`,
  ).run(operationId, jobId, nowIso, id, subjectId);
  return result.changes === 1;
}

export function refreshPreview(input: {
  id: string;
  subjectId: string;
  payloadHash: string;
  previewJson: string;
  expiresAt: string;
  updatedAt: string;
}): boolean {
  const result = getRawDb().prepare(
    `UPDATE pending_actions
     SET status = 'pending', payload_hash = ?, preview_json = ?, expires_at = ?,
         updated_at = ?, approved_at = NULL, applied_at = NULL,
         operation_id = NULL, job_id = NULL, error_json = NULL
     WHERE id = ? AND subject_id = ? AND status = 'approved'`,
  ).run(
    input.payloadHash,
    input.previewJson,
    input.expiresAt,
    input.updatedAt,
    input.id,
    input.subjectId,
  );
  return result.changes === 1;
}

/**
 * 仅用于页面 apply 在 vault 锁内发现陈旧 HEAD 的补偿转换。
 * operationId 必须匹配本次执行抢占，避免把其他执行者或已完成 action 退回 pending。
 */
export function refreshExecutingPreview(input: {
  id: string;
  subjectId: string;
  operationId: string;
  payloadHash: string;
  previewJson: string;
  expiresAt: string;
  updatedAt: string;
}): boolean {
  const result = getRawDb().prepare(
    `UPDATE pending_actions
     SET status = 'pending', payload_hash = ?, preview_json = ?, expires_at = ?,
         updated_at = ?, approved_at = NULL, applied_at = NULL,
         operation_id = NULL, job_id = NULL, error_json = NULL
     WHERE id = ? AND subject_id = ? AND status = 'executing' AND operation_id = ?`,
  ).run(
    input.payloadHash,
    input.previewJson,
    input.expiresAt,
    input.updatedAt,
    input.id,
    input.subjectId,
    input.operationId,
  );
  return result.changes === 1;
}

export function rejectPending(id: string, subjectId: string, nowIso: string): boolean {
  const result = getRawDb().prepare(
    `UPDATE pending_actions SET status = 'rejected', updated_at = ?
     WHERE id = ? AND subject_id = ? AND status = 'pending'`,
  ).run(nowIso, id, subjectId);
  return result.changes === 1;
}

export function markApplied(
  id: string,
  subjectId: string,
  nowIso: string,
  refs: { operationId?: string; jobId?: string } = {},
): boolean {
  const result = getRawDb().prepare(
    `UPDATE pending_actions
     SET status = 'applied', applied_at = ?, updated_at = ?, error_json = NULL,
         operation_id = COALESCE(?, operation_id), job_id = COALESCE(?, job_id)
     WHERE id = ? AND subject_id = ? AND status = 'executing'`,
  ).run(nowIso, nowIso, refs.operationId ?? null, refs.jobId ?? null, id, subjectId);
  return result.changes === 1;
}

export function markFailed(
  id: string,
  subjectId: string,
  errorJson: string,
  nowIso: string,
): boolean {
  const result = getRawDb().prepare(
    `UPDATE pending_actions
     SET status = 'failed', error_json = ?, updated_at = ?
     WHERE id = ? AND subject_id = ? AND status IN ('approved','executing')`,
  ).run(errorJson, nowIso, id, subjectId);
  return result.changes === 1;
}

export function expirePending(nowIso: string): number {
  return getRawDb().prepare(
    `UPDATE pending_actions
     SET status = 'expired', updated_at = ?
     WHERE status = 'pending' AND expires_at <= ?`,
  ).run(nowIso, nowIso).changes;
}

export function pruneTerminal(cutoffIso: string): number {
  return getRawDb().prepare(
    `DELETE FROM pending_actions
     WHERE status IN ('applied','rejected','expired','failed') AND updated_at < ?`,
  ).run(cutoffIso).changes;
}
