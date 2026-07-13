import type { LintFinding } from '@/lib/contracts';
import * as queue from '../jobs/queue';
import { selectLatestFindings } from './lint-latest';
import {
  researchFindingSnapshot,
  type ResearchFindingSnapshot,
} from './research-provenance';

export const MAX_RESEARCH_FINDING_IDS = 100;

const RESEARCH_FINDING_TYPES: ReadonlySet<LintFinding['type']> = new Set([
  'coverage-gap',
  'thin-page',
]);

export type ResearchScopeErrorCode =
  | 'invalid-finding-count'
  | 'lint-snapshot-unavailable'
  | 'lint-snapshot-mismatch'
  | 'invalid-finding-scope';

/** Research 请求中可安全回传给调用方的范围或契约错误。 */
export class ResearchScopeError extends Error {
  readonly code: ResearchScopeErrorCode;

  constructor(code: ResearchScopeErrorCode, message: string) {
    super(message);
    this.name = 'ResearchScopeError';
    this.code = code;
  }
}

export interface ResolvedResearchFinding {
  findingId: string;
  snapshot: ResearchFindingSnapshot;
}

export interface ResolvedResearchScope {
  topics: string[];
  findings: ResolvedResearchFinding[];
}

/** 从指定 subject 的 completed lint 精确解析主题，并物化不依赖原 job 的 finding 快照。 */
export function resolveResearchScopeFromFindingIds(
  subjectId: string,
  lintJobId: string,
  findingIds: string[],
): ResolvedResearchScope {
  if (findingIds.length === 0 || findingIds.length > MAX_RESEARCH_FINDING_IDS) {
    throw new ResearchScopeError(
      'invalid-finding-count',
      `Research findingIds must contain 1-${MAX_RESEARCH_FINDING_IDS} values`,
    );
  }

  // 基础设施异常必须保持原样，交由上层按未知错误处理。
  const lintJob = queue.get(lintJobId);
  if (
    !lintJob
    || lintJob.type !== 'lint'
    || lintJob.status !== 'completed'
    || lintJob.subjectId !== subjectId
  ) {
    throw new ResearchScopeError(
      'lint-snapshot-unavailable',
      'Research lint snapshot is missing or belongs to another subject',
    );
  }

  const snapshot = selectLatestFindings([lintJob]);
  if (snapshot.jobId !== lintJobId) {
    throw new ResearchScopeError(
      'lint-snapshot-mismatch',
      'Research lint snapshot mismatch',
    );
  }

  const requested = new Set(findingIds);
  const matches = snapshot.findings.filter((finding) => requested.has(finding.id));
  if (
    matches.length !== requested.size
    || matches.some((finding) => !RESEARCH_FINDING_TYPES.has(finding.type))
  ) {
    throw new ResearchScopeError(
      'invalid-finding-scope',
      'Research findingIds must reference coverage-gap or thin-page findings',
    );
  }

  return {
    topics: [...new Set(matches.map((finding) => finding.description))],
    findings: matches.map((finding) => ({
      findingId: finding.id,
      snapshot: researchFindingSnapshot(finding),
    })),
  };
}

/** 兼容只消费主题的内部调用；新 Research 落地应使用完整 scope。 */
export function resolveTopicsFromFindingIds(
  subjectId: string,
  lintJobId: string,
  findingIds: string[],
): string[] {
  return resolveResearchScopeFromFindingIds(subjectId, lintJobId, findingIds).topics;
}
