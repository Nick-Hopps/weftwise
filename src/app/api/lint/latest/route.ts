import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { selectLatestFindings } from '@/server/services/lint-latest';

export const runtime = 'nodejs';

/**
 * GET /api/lint/latest
 *
 * 返回当前 subject（默认）或全量（`?allSubjects=1`）最近一次 completed lint job 的 findings 快照。
 * 从未跑过返回 { jobId: null, findings: [] }。只读，仅 requireAuth。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const allSubjects = request.nextUrl.searchParams.get('allSubjects') === '1';

  if (allSubjects) {
    const jobs = queue
      .list({ type: 'lint', status: 'completed' })
      .filter((j) => j.subjectId === null);
    return NextResponse.json(selectLatestFindings(jobs));
  }

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;

  const jobs = queue.list({ type: 'lint', status: 'completed', subjectId: resolution.subject.id });
  return NextResponse.json(selectLatestFindings(jobs));
}
