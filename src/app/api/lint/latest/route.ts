import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { selectLatestFindings } from '@/server/services/lint-latest';
import {
  buildHealthSnapshot,
  MAX_REMEDIATION_JOBS,
} from '@/server/services/remediation-status';

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
    const lint = selectLatestFindings(
      queue.listRecent(
        { type: 'lint', status: 'completed', subjectId: null },
        1,
      ),
    );
    return NextResponse.json(
      buildHealthSnapshot(
        lint,
        queue.listRecent(undefined, MAX_REMEDIATION_JOBS),
        { readOnly: true },
      ),
    );
  }

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;

  const lint = selectLatestFindings(
    queue.listRecent(
      {
        type: 'lint',
        status: 'completed',
        subjectId: resolution.subject.id,
      },
      1,
    ),
  );
  return NextResponse.json(
    buildHealthSnapshot(
      lint,
      queue.listRecent(
        { subjectId: resolution.subject.id },
        MAX_REMEDIATION_JOBS,
      ),
    ),
  );
}
