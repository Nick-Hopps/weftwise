import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { readPageSources } from '@/server/sources/source-reader';
import { listSourcesForSubject } from '@/server/db/repos/sources-repo';
import { readSourcePresentation } from '@/server/sources/source-presentation';
import { readUrlSourceReference, urlSourceDisplayTitle } from '@/server/sources/url-source';

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
    const sources = listSourcesForSubject(resolution.subject.id).map((s) => {
      const urlReference = readUrlSourceReference(s);
      // 展示字段与实体类型无关：worker 抓取的 URL Source 与采集自主检索导入的网页
      // 快照都持久化了标题/描述；缺失时 URL Source 回退 hostname，其余回退 filename。
      const presentation = readSourcePresentation(s);
      const fallbackTitle = urlReference ? urlSourceDisplayTitle(urlReference) : s.filename;
      return {
        id: s.id,
        filename: s.filename,
        format: urlReference ? 'Web' : formatLabelFor(s.filename),
        title: presentation.title ?? fallbackTitle,
        ...(presentation.description ? { description: presentation.description } : {}),
      };
    });
    return NextResponse.json({ sources });
  }

  const sources = readPageSources(resolution.subject, slug);
  return NextResponse.json({ sources });
}
