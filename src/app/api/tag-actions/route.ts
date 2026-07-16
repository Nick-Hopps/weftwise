import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import {
  createTagBatchPendingActionPreview,
  listTagBatchPendingActions,
} from '@/server/services/pending-action-service';
import { TagBatchPayloadSchema } from '@/server/services/pending-action-payload';
import { pendingActionErrorResponse } from '../pending-actions/error-response';

export const runtime = 'nodejs';

export function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  try {
    return NextResponse.json({ actions: listTagBatchPendingActions({ subject }) });
  } catch (routeError) {
    return pendingActionErrorResponse(routeError);
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const { subject, error } = resolveSubjectFromRequest(request, { required: true, body });
  if (error) return error;
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const parsed = TagBatchPayloadSchema.safeParse({
    action: record.action,
    sourceTag: record.sourceTag,
    ...(record.targetTag !== undefined ? { targetTag: record.targetTag } : {}),
  });
  if (!parsed.success) {
    return NextResponse.json({
      error: parsed.error.issues[0]?.message ?? 'Invalid tag action.',
      code: 'INVALID_TAG_ACTION',
    }, { status: 400 });
  }

  try {
    const action = await createTagBatchPendingActionPreview({
      subject,
      payload: parsed.data,
    });
    return NextResponse.json({ action }, { status: 201 });
  } catch (routeError) {
    return pendingActionErrorResponse(routeError);
  }
}
