import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as operationsRepo from '@/server/db/repos/operations-repo';
import {
  applyPlannedHistoryRevert,
  HistoryOperationError,
  planHistoryRevert,
} from '@/server/services/history-tools';

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
    const plan = await planHistoryRevert(subject, id);
    const applied = await applyPlannedHistoryRevert(plan);
    operationsRepo.markReverted(applied.originalOperationId);
    return NextResponse.json({
      revertedOperationId: applied.originalOperationId,
      newCommitSha: applied.newCommitSha,
      affectedSlugs: applied.affectedSlugs,
    });
  } catch (caught) {
    if (caught instanceof HistoryOperationError) {
      if (caught.code === 'HISTORY_NOT_FOUND') {
        return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
      }
      if (caught.code === 'HISTORY_ALREADY_REVERTED') {
        return NextResponse.json({ error: 'Operation already reverted' }, { status: 409 });
      }
      if (caught.code === 'HISTORY_REVERT_INVALID') {
        return NextResponse.json(
          { error: 'Revert validation failed', errors: caught.details },
          { status: 422 },
        );
      }
    }
    throw caught;
  }
}
