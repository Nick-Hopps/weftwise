import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { SubjectError } from '@/server/db/repos/subjects-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';

export const runtime = 'nodejs';

const CreateSubjectSchema = z.object({
  slug: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
});

/**
 * GET /api/subjects
 * Returns all subjects with their basic metadata + page counts.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const subjects = subjectsRepo.listSubjects().map((s) => ({
    ...s,
    pageCount: subjectsRepo.countPages(s.id),
  }));

  return NextResponse.json(subjects);
}

/**
 * POST /api/subjects
 * Body: { slug, name, description? }
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

  const parsed = CreateSubjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const subject = subjectsRepo.create(parsed.data);
    return NextResponse.json(subject, { status: 201 });
  } catch (err) {
    if (err instanceof SubjectError) {
      const status = err.code === 'slug-conflict' ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
