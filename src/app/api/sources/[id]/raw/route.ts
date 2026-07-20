import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { getSource } from '@/server/db/repos/sources-repo';
import { getById as getSubjectById } from '@/server/db/repos/subjects-repo';
import { getRawSourceBuffer, getRawSourceContent } from '@/server/sources/source-store';
import { readUrlSourceReference } from '@/server/sources/url-source';

export const runtime = 'nodejs';

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
};

/**
 * HTML 预览的运行期硬边界：允许页面自带的内联脚本/样式/图片渲染，但禁止外部脚本与
 * 一切对外连接（connect-src 'none' 切断 fetch/XHR/WebSocket/sendBeacon 外发）。
 * 配合 iframe sandbox 的 opaque origin，恶意脚本即便运行也偷不到、发不出。
 */
const HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline' https: http:",
  "img-src 'self' data: https: http:",
  "font-src https: http: data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

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

  const urlReference = readUrlSourceReference(source);
  if (urlReference) {
    return NextResponse.redirect(urlReference.originUrl, 307);
  }

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

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=300',
  };
  if (ext === '.html' || ext === '.htm') {
    headers['Content-Security-Policy'] = HTML_CSP;
  }
  return new NextResponse(content, { headers });
}
