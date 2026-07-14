import { randomUUID } from 'node:crypto';
import type {
  Changeset,
  ChangesetEntry,
  HistoryDiffInput,
  HistoryDiffResult,
  HistoryListInput,
  HistoryListResult,
  Subject,
} from '@/lib/contracts';
import * as operationsRepo from '../db/repos/operations-repo';
import type { OperationRow } from '../db/repos/operations-repo';
import {
  getDiff,
  getFileAtCommit,
  getVaultHead,
  getVaultLog,
} from '../git/git-service';
import { buildHistoryEntries } from '../wiki/history';
import { parseWikiPath } from '../wiki/page-identity';
import { buildRevertEntries } from '../wiki/revert';
import { buildUnifiedDiff } from '../wiki/unified-diff';
import {
  applyChangeset,
  captureSubjectMutationEpoch,
  createChangeset,
  validateChangeset,
} from '../wiki/wiki-transaction';

const HISTORY_LIMIT_DEFAULT = 20;
const HISTORY_LIMIT_MAX = 50;

export type HistoryOperationErrorCode =
  | 'HISTORY_NOT_FOUND'
  | 'HISTORY_ALREADY_REVERTED'
  | 'HISTORY_INVALID_CHANGESET'
  | 'HISTORY_REVERT_INVALID';

export class HistoryOperationError extends Error {
  constructor(
    readonly code: HistoryOperationErrorCode,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'HistoryOperationError';
  }
}

export interface PlannedHistoryRevert {
  originalOperationId: string;
  preHead: string;
  changeset: Changeset;
  summary: string;
  affectedPages: Array<{ slug: string; action: 'create' | 'update' | 'delete' }>;
  diff: string;
  warnings: string[];
}

function scopedOperation(subject: Subject, operationId: string): OperationRow {
  const operation = operationsRepo.getById(operationId);
  if (
    !operation
    || operation.subjectId !== subject.id
    || !operation.postHead
    || !['applied', 'reverted'].includes(operation.status)
  ) {
    throw new HistoryOperationError('HISTORY_NOT_FOUND', 'History operation not found.');
  }
  return operation;
}

function parseOperationEntries(operation: OperationRow): ChangesetEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(operation.changesetJson);
  } catch {
    throw new HistoryOperationError('HISTORY_INVALID_CHANGESET', 'History operation has an invalid changeset.');
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new HistoryOperationError('HISTORY_INVALID_CHANGESET', 'History operation has an invalid changeset.');
  }
  const entries = value as Array<Record<string, unknown>>;
  if (entries.some((entry) => (
    !['create', 'update', 'delete'].includes(String(entry.action))
    || typeof entry.path !== 'string'
    || (entry.action === 'delete' ? entry.content !== null : typeof entry.content !== 'string')
  ))) {
    throw new HistoryOperationError('HISTORY_INVALID_CHANGESET', 'History operation has an invalid changeset.');
  }
  return entries as unknown as ChangesetEntry[];
}

function affectedPages(entries: ChangesetEntry[]) {
  return entries.map((entry) => {
    const identity = parseWikiPath(entry.path);
    if (!identity) throw new Error(`History operation contains an invalid wiki path: ${entry.path}`);
    return { slug: identity.slug, action: entry.action };
  });
}

async function fileAtCommitOrNull(path: string, sha: string): Promise<string | null> {
  try {
    return await getFileAtCommit(path, sha);
  } catch {
    return null;
  }
}

export async function listHistory(
  subject: Subject,
  input: HistoryListInput = {},
  options: { defaultLimit?: number; maxLimit?: number } = {},
): Promise<HistoryListResult> {
  const maxLimit = options.maxLimit ?? HISTORY_LIMIT_MAX;
  const limit = Math.min(input.limit ?? options.defaultLimit ?? HISTORY_LIMIT_DEFAULT, maxLimit);
  const rows = operationsRepo.listForSubject(subject.id);
  const commits = await getVaultLog();
  const commitBySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const entries = buildHistoryEntries(rows, commitBySha)
    .filter((entry) => !input.slug || entry.affectedPages.some((page) => page.slug === input.slug))
    .slice(0, limit);
  return { entries };
}

export async function readHistoryDiff(
  subject: Subject,
  input: HistoryDiffInput,
): Promise<HistoryDiffResult> {
  const operation = scopedOperation(subject, input.operationId);
  const entry = buildHistoryEntries([operation], new Map())[0]!;
  return {
    operationId: operation.id,
    status: entry.status,
    affectedPages: entry.affectedPages,
    diff: await getDiff(operation.preHead, operation.postHead!),
  };
}

export async function planHistoryRevert(
  subject: Subject,
  operationId: string,
): Promise<PlannedHistoryRevert> {
  const operation = scopedOperation(subject, operationId);
  if (operation.status === 'reverted') {
    throw new HistoryOperationError(
      'HISTORY_ALREADY_REVERTED',
      'History operation is already reverted.',
    );
  }
  if (operation.status !== 'applied') {
    throw new HistoryOperationError('HISTORY_NOT_FOUND', 'History operation is not revertable.');
  }

  const originalEntries = parseOperationEntries(operation);
  const paths = [...new Set(originalEntries.map((entry) => entry.path))];
  const preHead = await getVaultHead();
  const priorByPath = new Map<string, string | null>();
  const currentByPath = new Map<string, string | null>();
  for (const path of paths) {
    priorByPath.set(path, await fileAtCommitOrNull(path, operation.preHead));
    currentByPath.set(path, await fileAtCommitOrNull(path, preHead));
  }

  const entries = buildRevertEntries(
    originalEntries,
    (path) => priorByPath.get(path) ?? null,
    (path) => currentByPath.get(path) !== null,
  );
  const mutationEpoch = captureSubjectMutationEpoch(subject.id);
  const changeset = createChangeset(randomUUID(), subject, entries, mutationEpoch);
  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    throw new HistoryOperationError(
      'HISTORY_REVERT_INVALID',
      `History revert changeset invalid: ${validation.errors.join('; ')}`,
      validation.errors,
    );
  }

  return {
    originalOperationId: operation.id,
    preHead,
    changeset,
    summary: `回滚历史操作 ${operation.id}`,
    affectedPages: affectedPages(entries),
    diff: buildUnifiedDiff(entries.map((entry) => ({
      action: entry.action,
      path: entry.path,
      before: currentByPath.get(entry.path) ?? null,
      after: entry.action === 'delete' ? null : entry.content,
    }))),
    warnings: [
      '该回滚会恢复目标操作之前的内容，并覆盖其后对相同页面的修改。',
      ...(validation.warnings ?? []),
    ],
  };
}

export async function applyPlannedHistoryRevert(plan: PlannedHistoryRevert): Promise<{
  originalOperationId: string;
  operationId: string;
  newCommitSha: string | null;
  affectedSlugs: string[];
}> {
  const applied = await applyChangeset(
    plan.changeset,
    undefined,
    { expectedPreHead: plan.preHead },
  );
  return {
    originalOperationId: plan.originalOperationId,
    operationId: applied.id,
    newCommitSha: applied.postHead,
    affectedSlugs: plan.affectedPages.map((page) => page.slug),
  };
}
