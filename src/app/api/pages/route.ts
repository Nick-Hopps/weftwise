import { NextRequest, NextResponse } from 'next/server';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { requireAuth } from '@/server/middleware/auth';

export const runtime = 'nodejs';

/**
 * GET /api/pages
 * Returns all wiki pages ordered by title (slug, title, summary, tags, etc.).
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const pages = pagesRepo.getAllPages();
  return NextResponse.json(pages);
}
