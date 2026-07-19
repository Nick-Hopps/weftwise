import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { selectLatestFindings } from '@/server/services/lint-latest';
import {
  buildHealthSnapshot,
  MAX_REMEDIATION_JOBS,
} from '@/server/services/remediation-status';
import { getResearchRunsByJobIds } from '@/server/services/research-approval-service';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import type { Job, LintLatestResult, ResearchRunView } from '@/lib/contracts';

export const runtime = 'nodejs';

/**
 * GET /api/lint/latest
 *
 * 返回当前 subject（默认）或全量（`?allSubjects=1`）最近一次 completed lint job 的 Health 快照。
 * 从未跑过返回完整空快照。只读，仅 requireAuth。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const allSubjects = request.nextUrl.searchParams.get('allSubjects') === '1';

  if (allSubjects) {
    const latestLint = queue.listLatestCompletedLint(null);
    const lint = projectCurrentOrphanSources(selectLatestFindings(
      latestLint ? [latestLint] : [],
    ));
    const recentJobs = queue.listRecent(undefined, MAX_REMEDIATION_JOBS);
    return NextResponse.json(
      buildHealthSnapshot(
        lint,
        recentJobs,
        { readOnly: true, researchRuns: readResearchRuns(recentJobs) },
      ),
    );
  }

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;

  const latestLint = queue.listLatestCompletedLint(resolution.subject.id);
  const lint = projectCurrentOrphanSources(selectLatestFindings(
    latestLint ? [latestLint] : [],
  ));
  const recentJobs = queue.listRecent(
    { subjectId: resolution.subject.id },
    MAX_REMEDIATION_JOBS,
  );
  return NextResponse.json(
    buildHealthSnapshot(
      lint,
      recentJobs,
      { researchRuns: readResearchRuns(recentJobs) },
    ),
  );
}

/**
 * lint job 是历史快照；orphan-source 则取决于当前 sources/page_sources 状态。
 * 删除或重新关联 source 后，读取 Health 时立即投影掉已失效 finding，避免刷新后复活。
 */
function projectCurrentOrphanSources(lint: LintLatestResult): LintLatestResult {
  const subjectIds = new Set(
    lint.findings
      .filter((finding) => finding.type === 'orphan-source' && finding.sourceId)
      .map((finding) => finding.subjectId),
  );
  if (subjectIds.size === 0) return lint;

  const currentOrphanKeys = new Set<string>();
  for (const subjectId of subjectIds) {
    for (const source of sourcesRepo.listUnreferencedSources(subjectId)) {
      currentOrphanKeys.add(`${subjectId}\u0000${source.id}`);
    }
  }

  const findings = lint.findings.filter((finding) => (
    finding.type !== 'orphan-source'
    || !finding.sourceId
    || currentOrphanKeys.has(`${finding.subjectId}\u0000${finding.sourceId}`)
  ));
  if (findings.length === lint.findings.length) return lint;

  return {
    ...lint,
    findings,
    bySeverity: {
      critical: findings.filter((finding) => finding.severity === 'critical').length,
      warning: findings.filter((finding) => finding.severity === 'warning').length,
      info: findings.filter((finding) => finding.severity === 'info').length,
    },
  };
}

/** route 层按 subject 批量读取，保持 snapshot builder 纯函数并避免逐 finding 查询。 */
function readResearchRuns(jobs: Job[]): ResearchRunView[] {
  const idsBySubject = new Map<string, Set<string>>();
  for (const job of jobs) {
    if (job.type !== 'research' || !job.subjectId) continue;
    const ids = idsBySubject.get(job.subjectId) ?? new Set<string>();
    ids.add(job.id);
    idsBySubject.set(job.subjectId, ids);
  }

  return [...idsBySubject.entries()].flatMap(([subjectId, ids]) =>
    getResearchRunsByJobIds([...ids], subjectId),
  );
}
