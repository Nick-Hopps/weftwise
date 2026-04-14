import { NextRequest, NextResponse } from 'next/server';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { requireAuth } from '@/server/middleware/auth';

export const runtime = 'nodejs';

/**
 * GET /api/search?q=search+term
 *
 * Full-text search over wiki pages using SQLite FTS5.
 * Returns ranked results with highlighted snippets.
 * Empty or missing `q` returns an empty results array.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const q = request.nextUrl.searchParams.get('q');

  if (!q || q.trim().length === 0) {
    return NextResponse.json({ results: [] });
  }

  const results = pagesRepo.searchPages(q.trim());

  return NextResponse.json({ results });
}
