import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import * as jobsRepo from '@/server/db/repos/jobs-repo';
import * as queue from '@/server/jobs/queue';
import * as events from '@/server/jobs/events';

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
  const subject = resolution.subject;

  const { id } = await params;
  const source = sourcesRepo.getSource(id);
  if (!source || source.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  // 仍需零关联：已被页面引用的 source 不是孤儿，不允许经此端点重跑
  const unreferenced = sourcesRepo.listUnreferencedSources(subject.id).some((s) => s.id === id);
  if (!unreferenced) {
    return NextResponse.json({ error: 'already-referenced' }, { status: 409 });
  }

  const job = jobsRepo.findLatestIngestJobForSource(subject.id, id);
  if (job && (job.status === 'pending' || job.status === 'running')) {
    return NextResponse.json({ error: 'in-flight' }, { status: 409 });
  }

  if (job && job.status === 'failed') {
    // 已被用户手动终结的 job 检查点已清，requeue 会复活它——改走新建分支
    let cancelled = false;
    try {
      cancelled = !!(JSON.parse(job.resultJson ?? '{}') as { cancelled?: unknown }).cancelled;
    } catch {
      // result 不可解析 → 视为可 requeue
    }
    if (!cancelled) {
      queue.requeue(job.id);
      events.emit(job.id, 'job:retrying', 'Manual re-ingest — resuming from checkpoint', { manual: true });
      return NextResponse.json({ jobId: job.id }, { status: 202 });
    }
  }

  const newJob = queue.enqueue(
    'ingest',
    { sourceId: source.id, filename: source.filename, subjectId: subject.id },
    subject.id,
  );
  return NextResponse.json({ jobId: newJob.id }, { status: 202 });
}
