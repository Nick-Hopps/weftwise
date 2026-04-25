import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';

export const runtime = 'nodejs';

/**
 * POST /api/lint
 *
 * Subject-scoped by default. Pass `{ allSubjects: true }` in the body to lint
 * every subject in one job (slow; use sparingly).
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

  const allSubjects =
    body && typeof body === 'object' && (body as { allSubjects?: boolean }).allSubjects === true;

  if (allSubjects) {
    const job = queue.enqueue('lint', {}, null);
    return NextResponse.json({ jobId: job.id, scope: 'all-subjects' });
  }

  const resolution = resolveSubjectFromRequest(request, { body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const job = queue.enqueue('lint', { subjectId: subject.id }, subject.id);
  return NextResponse.json({
    jobId: job.id,
    subjectId: subject.id,
    subjectSlug: subject.slug,
  });
}
