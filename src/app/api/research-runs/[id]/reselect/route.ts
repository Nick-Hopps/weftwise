import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { reselectResearchRun } from '@/server/services/research-approval-service';
import { researchRunErrorResponse } from '../../error-response';

export const runtime = 'nodejs';

const ReselectResearchRunBodySchema = z.object({
  subjectId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
}).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid reselect request.' }, { status: 400 });
  }
  const parsed = ReselectResearchRunBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid reselect request.' }, { status: 400 });
  }

  const { subject, error } = resolveSubjectFromRequest(request, {
    required: true,
    body: parsed.data,
  });
  if (error) return error;

  const { id } = await params;
  try {
    return NextResponse.json(reselectResearchRun({
      runId: id,
      subjectId: subject.id,
      expectedVersion: parsed.data.expectedVersion,
    }), { status: 202 });
  } catch (routeError) {
    return researchRunErrorResponse(routeError);
  }
}
