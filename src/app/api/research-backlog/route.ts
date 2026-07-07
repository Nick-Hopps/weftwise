import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as researchBacklogRepo from '@/server/db/repos/research-backlog-repo';
import type { ResearchBacklogEntry } from '@/lib/contracts';

export const runtime = 'nodejs';

/**
 * GET /api/research-backlog?status=open — 当前 subject 的待研究问题队列（T3.2）。
 * status 缺省时返回全部状态；只读，仅 requireAuth。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const statusParam = request.nextUrl.searchParams.get('status');
  const status =
    statusParam === 'open' || statusParam === 'researched' || statusParam === 'dismissed'
      ? (statusParam as ResearchBacklogEntry['status'])
      : undefined;

  const entries = researchBacklogRepo.listForSubject(subject.id, status);
  return NextResponse.json({ entries });
}
