import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { readPageSources } from '@/server/sources/source-reader';

export const runtime = 'nodejs';

/**
 * GET /api/sources?slug=<pageSlug>
 * Returns the source documents a page was written from, prepared (and capped)
 * for the split reading view. Subject resolved from query / cookie.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;

  const slug = request.nextUrl.searchParams.get('slug');
  if (!slug) {
    return NextResponse.json({ error: 'Missing slug' }, { status: 400 });
  }

  const sources = readPageSources(resolution.subject, slug);
  return NextResponse.json({ sources });
}
