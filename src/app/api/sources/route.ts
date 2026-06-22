import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { readPageSources } from '@/server/sources/source-reader';
import { listSourcesForSubject } from '@/server/db/repos/sources-repo';

export const runtime = 'nodejs';

function formatLabelFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'PDF';
  if (ext === '.md' || ext === '.mdx') return 'Markdown';
  if (ext === '.html' || ext === '.htm') return 'HTML';
  return 'Text';
}

/**
 * GET /api/sources?slug=<pageSlug>
 *   → the source documents a page was written from, prepared (and capped) for
 *     the split reading view.
 * GET /api/sources  (no slug)
 *   → a lightweight list of every source ingested into the subject, for the
 *     sidebar Sources section.
 * Subject resolved from query / cookie.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;

  const slug = request.nextUrl.searchParams.get('slug');
  if (!slug) {
    const sources = listSourcesForSubject(resolution.subject.id).map((s) => ({
      id: s.id,
      filename: s.filename,
      format: formatLabelFor(s.filename),
    }));
    return NextResponse.json({ sources });
  }

  const sources = readPageSources(resolution.subject, slug);
  return NextResponse.json({ sources });
}
