import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as conversationsRepo from '@/server/db/repos/conversations-repo';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  return NextResponse.json(conversationsRepo.listConversations(subject!.id));
}
