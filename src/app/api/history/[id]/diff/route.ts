import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as operationsRepo from '@/server/db/repos/operations-repo';
import { getDiff } from '@/server/git/git-service';

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
  const op = operationsRepo.getById(id);
  if (!op || op.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
  }
  if (!op.postHead) return NextResponse.json({ diff: '' });

  const diff = await getDiff(op.preHead, op.postHead);
  return NextResponse.json({ diff });
}
