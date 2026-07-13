import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getResearchRun } from '@/server/services/research-approval-service';
import { researchRunErrorResponse } from '../error-response';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  const { id } = await params;
  try {
    return NextResponse.json({ run: getResearchRun(id, subject.id) });
  } catch (routeError) {
    return researchRunErrorResponse(routeError);
  }
}
