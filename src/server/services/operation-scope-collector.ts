import { z } from 'zod';
import type {
  ChangesetEntry,
  PostconditionScope,
  Subject,
} from '@/lib/contracts';
import * as operationsRepo from '../db/repos/operations-repo';
import type { OperationRow } from '../db/repos/operations-repo';
import { parseWikiPath } from '../wiki/page-identity';

const ChangesetEntriesSchema = z.array(
  z.discriminatedUnion('action', [
    z.object({
      action: z.literal('create'),
      path: z.string().min(1),
      content: z.string(),
    }),
    z.object({
      action: z.literal('update'),
      path: z.string().min(1),
      content: z.string(),
    }),
    z.object({
      action: z.literal('delete'),
      path: z.string().min(1),
      content: z.null(),
    }),
  ]),
);

export class PostconditionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostconditionScopeError';
  }
}

function parseEntries(row: OperationRow): ChangesetEntry[] {
  try {
    return ChangesetEntriesSchema.parse(JSON.parse(row.changesetJson));
  } catch {
    throw new PostconditionScopeError(
      `Operation ${row.id} 的 changeset_json 无法解析。`,
    );
  }
}

/** 将已过滤的 operation 行严格转换为保序、去重的页面影响范围。 */
export function buildPostconditionScope(
  jobId: string,
  subject: Pick<Subject, 'id' | 'slug'>,
  rows: OperationRow[],
): PostconditionScope {
  const createdSlugs = new Set<string>();
  const updatedSlugs = new Set<string>();
  const deletedSlugs = new Set<string>();
  const touchedSlugs = new Set<string>();
  const operationIds = new Set<string>();

  for (const row of rows) {
    if (
      row.jobId !== jobId ||
      row.subjectId !== subject.id ||
      row.status !== 'applied' ||
      row.postHead === null
    ) {
      throw new PostconditionScopeError(
        `Operation ${row.id} 不属于当前已应用的 Job / Subject。`,
      );
    }

    operationIds.add(row.id);
    for (const entry of parseEntries(row)) {
      if (!entry.path.startsWith('wiki/')) {
        throw new PostconditionScopeError(
          `Operation ${row.id} 包含非 Wiki 路径。`,
        );
      }
      const identity = parseWikiPath(entry.path);
      if (
        !identity ||
        identity.subjectSlug !== subject.slug ||
        identity.slug.trim().length === 0
      ) {
        throw new PostconditionScopeError(
          `Operation ${row.id} 包含越界或非法页面路径。`,
        );
      }

      touchedSlugs.add(identity.slug);
      if (entry.action === 'create') createdSlugs.add(identity.slug);
      if (entry.action === 'update') updatedSlugs.add(identity.slug);
      if (entry.action === 'delete') deletedSlugs.add(identity.slug);
    }
  }

  return {
    jobId,
    subjectId: subject.id,
    createdSlugs: [...createdSlugs],
    updatedSlugs: [...updatedSlugs],
    deletedSlugs: [...deletedSlugs],
    touchedSlugs: [...touchedSlugs],
    operationIds: [...operationIds],
  };
}

/** 从 operations 仓储读取当前 Job 的权威写入记录并收集影响范围。 */
export function collectPostconditionScope(
  jobId: string,
  subject: Pick<Subject, 'id' | 'slug'>,
): PostconditionScope {
  return buildPostconditionScope(
    jobId,
    subject,
    operationsRepo.listAppliedForJob(jobId, subject.id),
  );
}
