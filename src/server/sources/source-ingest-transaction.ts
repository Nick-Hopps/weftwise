import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, Subject } from '@/lib/contracts';
import { vaultPath } from '../config/env';
import { getRawDb } from '../db/client';
import { deleteRawSourceFiles, saveRawSource, saveUrlSource } from './source-store';
import { createUrlSourceIdentity } from './url-source';

export interface SubjectWriteLease {
  subjectId: string;
  mutationEpoch: number;
}

export class SubjectWriteLeaseError extends Error {
  constructor(
    public readonly code: 'subject-not-found' | 'subject-maintenance' | 'subject-stale',
    message: string,
  ) {
    super(message);
    this.name = 'SubjectWriteLeaseError';
  }
}

interface PersistSourceAndEnqueueCommon {
  subject: Pick<Subject, 'id' | 'slug'>;
  lease: SubjectWriteLease;
  /** 仅供受信任的服务端协调器补充 lineage；受控字段始终由本函数覆盖。 */
  jobParams?: Record<string, unknown>;
  /** 仅供服务端协调器维持跨表事务边界；Route 不得透传。 */
  transactionHooks?: {
    beforePersist?: (sqlite: ReturnType<typeof getRawDb>) => void;
    afterEnqueue?: (
      sqlite: ReturnType<typeof getRawDb>,
      result: PersistSourceAndEnqueueResult,
    ) => void;
  };
}

export type PersistSourceAndEnqueueInput = PersistSourceAndEnqueueCommon & (
  | {
      kind?: 'raw';
      filename: string;
      content: Buffer | string;
      originUrl?: string;
    }
  | {
      kind: 'url';
      url: string;
    }
);

export interface PersistSourceAndEnqueueResult {
  sourceId: string;
  job: Job;
}

/** 在长 I/O 前读取 Subject 代次；真正写入时仍会在 IMMEDIATE transaction 中复验。 */
export function acquireSubjectWriteLease(subjectId: string): SubjectWriteLease {
  const row = getRawDb().prepare(`
    SELECT maintenance_state, mutation_epoch
    FROM subjects
    WHERE id = ?
  `).get(subjectId) as {
    maintenance_state: string;
    mutation_epoch: number;
  } | undefined;
  if (!row) {
    throw new SubjectWriteLeaseError('subject-not-found', 'Subject 已不存在');
  }
  if (row.maintenance_state !== 'active') {
    throw new SubjectWriteLeaseError('subject-maintenance', 'Subject 正在维护，请稍后重试');
  }
  return { subjectId, mutationEpoch: row.mutation_epoch };
}

/**
 * 在同一 IMMEDIATE transaction 内复验 Subject lease、保存 source 并插入 ingest job。
 * SQLite 回滚不能覆盖文件系统，因此异常路径会删除新 sidecar 并恢复原 raw 文件。
 */
export function persistSourceAndEnqueueIngest(
  input: PersistSourceAndEnqueueInput,
): PersistSourceAndEnqueueResult {
  if (input.lease.subjectId !== input.subject.id) {
    throw new SubjectWriteLeaseError('subject-stale', 'Subject 写 lease 与目标不匹配');
  }

  const sqlite = getRawDb();
  const isUrlSource = input.kind === 'url';
  const safeFilename = isUrlSource
    ? createUrlSourceIdentity(input.url).filename
    : path.basename(input.filename);
  const rawPath = isUrlSource ? null : vaultPath('raw', input.subject.slug, safeFilename);
  let previousRaw: Buffer | null = null;
  let rawExisted = false;
  const compensation: { createdSourceId: string | null } = { createdSourceId: null };

  const transaction = sqlite.transaction((): PersistSourceAndEnqueueResult => {
    const row = sqlite.prepare(`
      SELECT slug, maintenance_state, mutation_epoch
      FROM subjects
      WHERE id = ?
    `).get(input.subject.id) as {
      slug: string;
      maintenance_state: string;
      mutation_epoch: number;
    } | undefined;
    if (!row) {
      throw new SubjectWriteLeaseError('subject-not-found', 'Subject 已不存在');
    }
    if (row.slug !== input.subject.slug || row.mutation_epoch !== input.lease.mutationEpoch) {
      throw new SubjectWriteLeaseError('subject-stale', 'Subject 已在抓取期间变更');
    }
    if (row.maintenance_state !== 'active') {
      throw new SubjectWriteLeaseError('subject-maintenance', 'Subject 正在维护，请稍后重试');
    }

    input.transactionHooks?.beforePersist?.(sqlite);

    if (rawPath) {
      rawExisted = fs.existsSync(rawPath);
      previousRaw = rawExisted ? fs.readFileSync(rawPath) : null;
    }
    const saved = isUrlSource
      ? saveUrlSource(input.subject, input.url)
      : saveRawSource(
          input.subject,
          input.filename,
          input.content,
          input.originUrl ? { originUrl: input.originUrl } : undefined,
        );
    if (saved.created) compensation.createdSourceId = saved.id;

    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      type: 'ingest',
      status: 'pending',
      subjectId: input.subject.id,
      paramsJson: JSON.stringify({
        ...input.jobParams,
        sourceId: saved.id,
        filename: safeFilename,
        subjectId: input.subject.id,
      }),
      resultJson: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      attemptCount: 0,
    };
    sqlite.prepare(`
      INSERT INTO jobs (
        id, type, status, subject_id, params_json, result_json, created_at,
        started_at, completed_at, lease_expires_at, heartbeat_at, attempt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.type,
      job.status,
      job.subjectId,
      job.paramsJson,
      job.resultJson,
      job.createdAt,
      job.startedAt,
      job.completedAt,
      job.leaseExpiresAt,
      job.heartbeatAt,
      job.attemptCount,
    );
    const result = { sourceId: saved.id, job };
    input.transactionHooks?.afterEnqueue?.(sqlite, result);
    return result;
  });

  try {
    return transaction.immediate();
  } catch (error) {
    if (compensation.createdSourceId) {
      deleteRawSourceFiles(
        input.subject.slug,
        safeFilename,
        compensation.createdSourceId,
      );
      try {
        if (rawPath && rawExisted && previousRaw) {
          fs.mkdirSync(path.dirname(rawPath), { recursive: true });
          fs.writeFileSync(rawPath, previousRaw);
        }
      } catch {
        // best-effort 补偿；原始异常仍是调用方需要处理的主错误。
      }
    }
    throw error;
  }
}
