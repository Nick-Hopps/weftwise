import type { LintFinding } from '@/lib/contracts';
import * as queue from '../jobs/queue';
import { selectLatestFindings } from './lint-latest';

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

/** 从指定 subject 的指定 completed lint 快照精确解析可 Research finding 主题。 */
export function resolveTopicsFromFindingIds(
  subjectId: string,
  lintJobId: string,
  findingIds: string[],
): string[] {
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

  return [...new Set(matches.map((finding) => finding.description))];
}
