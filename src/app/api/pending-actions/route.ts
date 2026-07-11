import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { listPendingActions } from '@/server/services/pending-action-service';
import { pendingActionErrorResponse } from './error-response';

export const runtime = 'nodejs';

export function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const conversationId = request.nextUrl.searchParams.get('conversationId')?.trim();
  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });
  }

  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  try {
    const actions = listPendingActions({ conversationId, subject });
    return NextResponse.json({ actions });
  } catch (routeError) {
    return pendingActionErrorResponse(routeError);
  }
}
