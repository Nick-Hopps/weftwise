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

  // 原子取消（落终态 + 清检查点 + 置 cancel 标记）。结果以 requestCancel 为准，避免
  // get 到 requestCancel 之间的 TOCTOU（任务可能在此刻刚完成）。
  const result = queue.requestCancel(id);
  if (result === 'not-found') {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (result === 'already-terminal') {
    return NextResponse.json(
      { error: `Cannot cancel a job with status "${job.status}"` },
      { status: 409 },
    );
  }

  events.emit(id, 'job:cancelled', 'Job cancelled by user', { manual: true });
  return NextResponse.json(queue.get(id), { status: 200 });
}
