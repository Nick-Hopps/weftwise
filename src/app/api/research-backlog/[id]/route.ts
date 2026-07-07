import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as researchBacklogRepo from '@/server/db/repos/research-backlog-repo';
import type { ResearchBacklogEntry } from '@/lib/contracts';

export const runtime = 'nodejs';

const VALID_STATUSES: ResearchBacklogEntry['status'][] = ['open', 'researched', 'dismissed'];

/**
 * PATCH /api/research-backlog/[id] — 更新一条待研究问题的状态（T3.2）。
 * body: { status: 'open'|'researched'|'dismissed', researchJobId?: string }
 */
export async function PATCH(
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

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const status = (body as { status?: unknown }).status;
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as ResearchBacklogEntry['status'])) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }
  const researchJobIdRaw = (body as { researchJobId?: unknown }).researchJobId;
  const researchJobId = typeof researchJobIdRaw === 'string' ? researchJobIdRaw : undefined;

  const { id } = await params;
  const existing = researchBacklogRepo.getById(id);
  if (!existing || existing.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Research backlog entry not found' }, { status: 404 });
  }

  const updated = researchBacklogRepo.updateStatus(id, status as ResearchBacklogEntry['status'], researchJobId);
  return NextResponse.json({ entry: updated });
}
