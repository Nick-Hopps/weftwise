import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import {
  reingestOrphanSource,
  SourceReingestError,
} from '@/server/services/source-reingest';

export const runtime = 'nodejs';

/**
 * POST /api/sources/[id]/reingest —— 重新触发孤儿 source 的 ingest。
 * 有可续传的 failed job 时 requeue 原 job（checkpoint 续传）；
 * 查无 job / job 已 completed / failed 但已被用户终结（cancelled）时新建 ingest job。
 * 前端统一只调本端点，无需区分有无历史 job。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const { id } = await params;
  if (id.trim().length === 0) {
    return NextResponse.json({ error: 'source-not-found' }, { status: 404 });
  }

  try {
    const result = reingestOrphanSource({
      subjectId: resolution.subject.id,
      sourceId: id,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof SourceReingestError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status },
      );
    }
    console.error('[source-reingest] request failed', error);
    return NextResponse.json(
      { error: 'internal-error' },
      { status: 500 },
    );
  }
}
