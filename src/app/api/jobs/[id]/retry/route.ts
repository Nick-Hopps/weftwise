import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import * as events from '@/server/jobs/events';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { retryResearchIngestJob } from '@/server/services/research-approval-service';
import { researchRunErrorResponse } from '../../../research-runs/error-response';

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

  // 已被用户手动终结（result.cancelled=true）的 job 不可重试：它是被主动放弃的报错摄取，
  // 检查点已清，重试只会从零重跑、复活用户已结束的任务。要再摄取请重新上传。
  let cancelled = false;
  try {
    cancelled = !!(JSON.parse(job.resultJson ?? '{}') as { cancelled?: unknown }).cancelled;
  } catch {
    // result 不可解析 → 视为可重试
  }
  if (cancelled) {
    return NextResponse.json(
      { error: 'This ingest was terminated and can no longer be resumed. Start a new ingest instead.' },
      { status: 409 },
    );
  }

  let jobParams: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(job.paramsJson ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      jobParams = parsed as Record<string, unknown>;
    }
  } catch {
    // 损坏 params 保持既有兼容路径，后续 worker 会给出权威错误。
  }
  // source 已被删除（如通过 Health 页 orphan-source 的 Delete source）时不可重试：
  // 原始文件已不在磁盘，requeue 会让 worker 在 loadCleanText 立即报 "Source file not found"。
  // 与 POST /api/sources/[id]/reingest 的存在性校验保持一致，堵住这一条独立的重试路径。
  let sourceId: string | undefined;
  try {
    sourceId = (jobParams ?? JSON.parse(job.paramsJson ?? '{}') as Record<string, unknown>)
      .sourceId as string | undefined;
  } catch {
    // params 不可解析 → 跳过校验（不太可能发生，ingest job 入队时总是写合法 JSON）
  }
  if (sourceId && !sourcesRepo.getSource(sourceId)) {
    return NextResponse.json(
      { error: 'The source file for this ingest was deleted. Start a new ingest instead.' },
      { status: 409 },
    );
  }

  const provenance = parseResearchProvenance(jobParams?.researchProvenance);
  if (jobParams && Object.prototype.hasOwnProperty.call(jobParams, 'researchProvenance')) {
    if (!provenance || !job.subjectId) {
      return NextResponse.json(
        { error: 'Research provenance for this ingest is invalid.' },
        { status: 409 },
      );
    }
    try {
      const result = retryResearchIngestJob({
        ...provenance,
        ingestJobId: id,
        subjectId: job.subjectId,
      });
      events.emit(id, 'job:retrying', 'Manual retry — resuming Research ingest from checkpoint', {
        manual: true,
        research: true,
        runId: provenance.runId,
      });
      return NextResponse.json({ ...queue.get(id), researchRun: result.run }, { status: 202 });
    } catch (error) {
      return researchRunErrorResponse(error);
    }
  }

  // 无条件 requeue（刻意绕过 worker 的 isRetryableError，让用户能手动重试业务失败）
  queue.requeue(id);
  events.emit(id, 'job:retrying', 'Manual retry — resuming from checkpoint', { manual: true });

  return NextResponse.json(queue.get(id), { status: 202 });
}

function parseResearchProvenance(value: unknown): {
  runId: string;
  approvalId: string;
  candidateId: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3
    || !keys.every((key) => ['runId', 'approvalId', 'candidateId'].includes(key))
    || ![record.runId, record.approvalId, record.candidateId]
      .every((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
  ) return null;
  return record as { runId: string; approvalId: string; candidateId: string };
}
