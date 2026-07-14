import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { readHistoryDiff } from '@/server/services/history-tools';

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
    const result = await readHistoryDiff(subject, { operationId: id });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
  }
}
