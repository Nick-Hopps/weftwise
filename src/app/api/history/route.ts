import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as operationsRepo from '@/server/db/repos/operations-repo';
import { getVaultLog } from '@/server/git/git-service';
import { buildHistoryEntries } from '@/server/wiki/history';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { subject, error } = resolveSubjectFromRequest(request, { required: true });
  if (error) return error;

  const rows = operationsRepo.listForSubject(subject.id);
  const commits = await getVaultLog();
  const commitBySha = new Map(commits.map((c) => [c.sha, c]));
  return NextResponse.json(buildHistoryEntries(rows, commitBySha));
}
