/**
 * 从一组 lint job 中选出最近一次 completed 的 findings 快照。
 * 纯函数：不触 DB / 请求，便于单测；scope（subject vs all）由调用方在传入前用 queue.list 过滤。
 */
import type { Job, EnrichedLintFinding, LintLatestResult } from '@/lib/contracts';

export function selectLatestFindings(jobs: Job[]): LintLatestResult {
  const completed = jobs.filter((j) => j.type === 'lint' && j.status === 'completed');
  if (completed.length === 0) {
    return { jobId: null, ranAt: null, bySeverity: { critical: 0, warning: 0, info: 0 }, findings: [] };
  }

  // createdAt 为 ISO-8601，字符串比较即时间序
  const latest = completed.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));

  let findings: EnrichedLintFinding[] = [];
  try {
    const parsed = latest.resultJson ? (JSON.parse(latest.resultJson) as { findings?: unknown }) : null;
    if (parsed && Array.isArray(parsed.findings)) {
      findings = parsed.findings as EnrichedLintFinding[];
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
