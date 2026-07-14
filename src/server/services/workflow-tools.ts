import type {
  Job,
  PendingActionPreview,
  Subject,
  WorkflowStatusResult,
} from '@/lib/contracts';
import { getVaultHead } from '../git/git-service';
import * as queue from '../jobs/queue';
import * as events from '../jobs/events';
import { isWebSearchConfigured } from '../search/web-search';
import { planReenrich } from './reenrich-enqueue';
import { reconcileResearchProvenanceForJob } from './research-provenance-reconciler';

export const WORKFLOW_RESEARCH_TOPIC_MAX_LENGTH = 500;

export const RESEARCH_APPROVAL_WARNING =
  '批准后只启动资料发现；研究候选仍需单独批准才会导入并写入 Wiki。';

export const CANCEL_APPROVAL_WARNING =
  '批准后任务会被终止；运行中的模型调用会在取消轮询生效后中断。';

function isCancelled(job: Job): boolean {
  if (!job.resultJson) return false;
  try {
    const result = JSON.parse(job.resultJson) as { cancelled?: unknown };
    return result.cancelled === true;
  } catch {
    return false;
  }
}

function scopedJob(subject: Subject, jobId: string): Job | null {
  const normalizedId = jobId.trim();
  if (!normalizedId) return null;
  const job = queue.get(normalizedId);
  return job?.subjectId === subject.id ? job : null;
}

export function readWorkflowStatus(
  subject: Subject,
  jobId: string,
): WorkflowStatusResult {
  const job = scopedJob(subject, jobId);
  if (!job) return { found: false, job: null };
  return {
    found: true,
    job: {
      jobId: job.id,
      type: job.type,
      status: job.status,
      cancelled: isCancelled(job),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      attemptCount: job.attemptCount,
    },
  };
}

export async function planWorkflowReenrich(
  subject: Subject,
  slug: string,
): Promise<PendingActionPreview> {
  return planReenrich(subject.id, slug.trim());
}

export function normalizeResearchTopic(topic: string): string {
  const normalized = topic.trim();
  if (!normalized) throw new Error('Research topic is required.');
  if (normalized.length > WORKFLOW_RESEARCH_TOPIC_MAX_LENGTH) {
    throw new Error(`Research topic must be ${WORKFLOW_RESEARCH_TOPIC_MAX_LENGTH} characters or fewer.`);
  }
  return normalized;
}

export async function planWorkflowResearch(
  _subject: Subject,
  topic: string,
): Promise<PendingActionPreview> {
  const normalized = normalizeResearchTopic(topic);
  if (!isWebSearchConfigured()) {
    throw new Error('Web search is not configured. Set it up before starting research.');
  }
  return {
    kind: 'workflow',
    preHead: await getVaultHead(),
    summary: `研究主题 ${normalized}`,
    affectedPages: [],
    diff: null,
    warnings: [RESEARCH_APPROVAL_WARNING],
  };
}

export function getCancellableWorkflowJob(subject: Subject, jobId: string): Job {
  const job = scopedJob(subject, jobId);
  if (!job) throw new Error('Workflow job not found in this subject.');
  if (job.status === 'completed' || job.status === 'failed') {
    throw new Error(`Cannot cancel a terminal workflow job with status "${job.status}".`);
  }
  return job;
}

export async function planWorkflowCancel(
  subject: Subject,
  jobId: string,
): Promise<PendingActionPreview> {
  const job = getCancellableWorkflowJob(subject, jobId.trim());
  return {
    kind: 'workflow',
    preHead: await getVaultHead(),
    summary: `取消 ${job.type} 任务 ${job.id}`,
    affectedPages: [],
    diff: null,
    warnings: [CANCEL_APPROVAL_WARNING],
  };
}

/** 取消已提交后的通知与 Research provenance 对账；失败不反转已提交的取消事务。 */
export function reportWorkflowCancellation(jobId: string): void {
  try {
    events.emit(jobId, 'job:cancelled', 'Job cancelled by user', { manual: true });
  } catch (error) {
    console.error('[workflow] cancel event emit failed', error);
  }
  try {
    reconcileResearchProvenanceForJob(jobId);
  } catch (error) {
    console.error('[research-provenance] workflow cancel reconcile failed', error);
  }
}
