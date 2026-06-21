import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as queue from '@/server/jobs/queue';

export const runtime = 'nodejs';

const SplitRequestSchema = z.object({
  sourceSlug: z.string().min(1),
  hint: z.string().optional(),
});

const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const body = await request.json().catch(() => null);

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const parsed = SplitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { sourceSlug, hint } = parsed.data;

  if (PROTECTED_SYSTEM_PAGES.has(sourceSlug)) {
    return NextResponse.json(
      { error: 'Cannot split protected system pages (index/log)' },
      { status: 400 },
    );
  }
  if (!pagesRepo.getPageBySlug(subject.id, sourceSlug)) {
    return NextResponse.json({ error: `Page "${sourceSlug}" not found` }, { status: 404 });
  }

  const job = queue.enqueue(
    'split',
    { sourceSlug, hint, subjectId: subject.id },
    subject.id,
  );
  return NextResponse.json({ jobId: job.id, subjectId: subject.id }, { status: 202 });
}
