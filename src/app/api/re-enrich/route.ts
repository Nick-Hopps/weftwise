import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import * as queue from '@/server/jobs/queue';

export const runtime = 'nodejs';

const BodySchema = z.object({ slug: z.string().trim().min(1) });

const META_SLUGS = new Set(['index', 'log']);

/**
 * POST /api/re-enrich
 * Body: { slug }（subject 经 resolveSubjectFromRequest 解析）
 * 校验后入队 re-enrich 任务，返回 202 + { jobId }。
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const { slug } = parsed.data;
  if (META_SLUGS.has(slug)) {
    return NextResponse.json({ error: 'Cannot re-enrich a meta page (index/log)' }, { status: 400 });
  }

  const page = pagesRepo.getPageBySlug(subject.id, slug);
  if (!page) {
    return NextResponse.json({ error: `Page "${slug}" not found` }, { status: 404 });
  }
  if (page.tags.includes('meta')) {
    return NextResponse.json({ error: 'Cannot re-enrich a meta page' }, { status: 400 });
  }

  const job = queue.enqueue('re-enrich', { slug, subjectId: subject.id }, subject.id);
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
