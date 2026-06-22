import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { getSource } from '@/server/db/repos/sources-repo';
import { getById as getSubjectById } from '@/server/db/repos/subjects-repo';
import { getRawSourceBuffer, getRawSourceContent } from '@/server/sources/source-store';

export const runtime = 'nodejs';

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
};

/**
 * GET /api/sources/[id]/raw
 * Streams the original ingested file inline — the PDF bytes for the browser's
 * built-in reader, or HTML for an iframe. Subject is derived from the source's
 * own record, so a plain `<iframe src>` (which can't set headers) works.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const source = getSource(id);
  if (!source) return NextResponse.json({ error: 'Source not found' }, { status: 404 });

  const subject = getSubjectById(source.subjectId);
  if (!subject) return NextResponse.json({ error: 'Source not found' }, { status: 404 });

  const ext = path.extname(source.filename).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? 'text/plain; charset=utf-8';

  if (ext === '.pdf') {
    const buf = getRawSourceBuffer(subject.slug, source.filename);
    if (!buf) return NextResponse.json({ error: 'Source file missing' }, { status: 404 });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(source.filename)}"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  }

  const content = getRawSourceContent(subject.slug, source.filename);
  if (content == null) return NextResponse.json({ error: 'Source file missing' }, { status: 404 });
  return new NextResponse(content, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' },
  });
}
