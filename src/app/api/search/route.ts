import { NextRequest, NextResponse } from 'next/server';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';

export const runtime = 'nodejs';

/**
 * GET /api/search?q=search+term
 * Subject-scoped FTS5 search. Resolves subject from query / cookie.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;

  const q = request.nextUrl.searchParams.get('q');
  if (!q || q.trim().length === 0) {
    return NextResponse.json({ results: [] });
  }

  const results = pagesRepo.searchPages(resolution.subject.id, q.trim());
  return NextResponse.json({ results });
}
