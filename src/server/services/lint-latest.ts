/**
 * 从一组 lint job 中选出最近一次 completed 的 findings 快照。
 * 纯函数：不触 DB / 请求，便于单测；scope（subject vs all）由调用方在传入前用 queue.list 过滤。
 */
import type { Job, EnrichedLintFinding, LintLatestResult } from '@/lib/contracts';
import { identifyFindings, type FindingIdentityInput } from './finding-identity';

const LINT_FINDING_TYPES = new Set([
  'broken-link',
  'orphan',
  'missing-frontmatter',
  'stale-source',
  'contradiction',
  'missing-crossref',
  'coverage-gap',
  'orphan-source',
  'thin-page',
]);

const LINT_FINDING_SEVERITIES = new Set(['critical', 'warning', 'info']);

function isHistoricalEvidence(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => (
      typeof item === 'object'
      && item !== null
      && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).pageSlug === 'string'
      && typeof (item as Record<string, unknown>).quote === 'string'
    ));
}

function isHistoricalFinding(value: unknown): value is FindingIdentityInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const finding = value as Record<string, unknown>;
  return (
    typeof finding.type === 'string'
    && LINT_FINDING_TYPES.has(finding.type)
    && typeof finding.severity === 'string'
    && LINT_FINDING_SEVERITIES.has(finding.severity)
    && typeof finding.pageSlug === 'string'
    && typeof finding.description === 'string'
    && (typeof finding.suggestedFix === 'string' || finding.suggestedFix === null)
    && typeof finding.subjectId === 'string'
    && typeof finding.subjectSlug === 'string'
    && (!('sourceId' in finding) || typeof finding.sourceId === 'string')
    && (!('sourceFilename' in finding) || typeof finding.sourceFilename === 'string')
    && (!('targetSlug' in finding) || typeof finding.targetSlug === 'string')
    && (!('evidence' in finding) || isHistoricalEvidence(finding.evidence))
    && (
      !('failedJobId' in finding)
      || typeof finding.failedJobId === 'string'
      || finding.failedJobId === null
    )
  );
}

export function selectLatestFindings(jobs: Job[]): LintLatestResult {
  const completed = jobs.filter((j) => j.type === 'lint' && j.status === 'completed');
  if (completed.length === 0) {
    return { jobId: null, ranAt: null, bySeverity: { critical: 0, warning: 0, info: 0 }, findings: [] };
  }

  // 按完成时间选最近一次（completedAt 为 ISO-8601，字符串比较即时间序；与返回的 ranAt 自洽）
  const latest = completed.reduce((a, b) => {
    const completedOrder = (a.completedAt ?? '').localeCompare(b.completedAt ?? '');
    if (completedOrder !== 0) return completedOrder > 0 ? a : b;
    return a.id.localeCompare(b.id) >= 0 ? a : b;
  });

  let findings: EnrichedLintFinding[] = [];
  try {
    const parsed = latest.resultJson ? (JSON.parse(latest.resultJson) as { findings?: unknown }) : null;
    if (parsed && Array.isArray(parsed.findings)) {
      findings = identifyFindings(parsed.findings.filter(isHistoricalFinding));
    }
  } catch {
    findings = [];
  }

  const bySeverity = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  return { jobId: latest.id, ranAt: latest.completedAt, bySeverity, findings };
}
