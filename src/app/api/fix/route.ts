import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';

export const runtime = 'nodejs';

/**
 * POST /api/fix — 修复当前 subject lint 发现的可自动修复问题。
 * 异步：入队 'fix' job，立即返回 202 + jobId。
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const job = queue.enqueue('fix', { subjectId: subject.id }, subject.id);
  return NextResponse.json(
    { jobId: job.id, subjectId: subject.id, subjectSlug: subject.slug },
    { status: 202 },
  );
}
