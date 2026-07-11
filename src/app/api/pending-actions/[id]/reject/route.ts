import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { rejectPendingAction } from '@/server/services/pending-action-service';
import { pendingActionErrorResponse } from '../../error-response';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { subject, error } = resolveSubjectFromRequest(request, { required: true, body });
  if (error) return error;

  const { id } = await params;
  try {
    const action = rejectPendingAction({ id, subject });
    return NextResponse.json({ action });
  } catch (routeError) {
    return pendingActionErrorResponse(routeError);
  }
}
