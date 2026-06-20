import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import * as events from '@/server/jobs/events';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const { id } = await params;
  const job = queue.get(id);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (job.type !== 'ingest') {
    return NextResponse.json({ error: 'Only ingest jobs can be retried' }, { status: 422 });
  }
  if (job.status !== 'failed') {
    return NextResponse.json(
      { error: `Cannot retry a job with status "${job.status}"` },
      { status: 409 },
    );
  }

  // 无条件 requeue（刻意绕过 worker 的 isRetryableError，让用户能手动重试业务失败）
  queue.requeue(id);
  events.emit(id, 'job:retrying', 'Manual retry — resuming from checkpoint', { manual: true });

  return NextResponse.json(queue.get(id), { status: 202 });
}
