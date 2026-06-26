import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { applySignal } from '@/server/services/apply-signal';

export const runtime = 'nodejs';

const Body = z.object({
  type: z.enum(['too_hard', 'too_easy', 'simplify_click', 'deepen_click', 'view_original']),
  slug: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid signal' }, { status: 400 });
  }
  const resolution = resolveSubjectFromRequest(request, { body });
  const subjectId = resolution.error ? null : resolution.subject.id;
  const userId = resolveUserId(request);
  const r = applySignal(userId, body.type, { subjectId, slug: body.slug ?? null });
  return NextResponse.json(r);
}
