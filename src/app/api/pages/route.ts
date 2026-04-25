import { NextRequest, NextResponse } from 'next/server';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';

export const runtime = 'nodejs';

/**
 * GET /api/pages
 * Returns wiki pages within the active subject (resolved from query / cookie).
 * Use `?subjectId=<id>` or `?s=<slug>` to override.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;

  const pages = pagesRepo.getAllPages(resolution.subject.id);
  return NextResponse.json(pages);
}
