import type {
  ImageGenerateInput,
  Job,
  PendingActionPreview,
  PersistedMarkdownBlockAnchor,
  SelectionAnchorInput,
  Subject,
  WorkflowPreviewInput,
  WorkflowStatusResult,
} from '@/lib/contracts';
import { ImageGenerateInputSchema } from '@/lib/contracts';
import { getVaultHead } from '../git/git-service';
import * as queue from '../jobs/queue';
import * as events from '../jobs/events';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import {
  createMarkdownBlockAnchor,
  resolveMarkdownBlockAnchor,
} from '../wiki/markdown-block-anchor';
import { isCanonicalPageSlug } from '../wiki/page-identity';
import { isWebSearchConfigured } from '../search/web-search';
import { planReenrich } from './reenrich-enqueue';
import { reconcileResearchProvenanceForJob } from './research-provenance-reconciler';

export const WORKFLOW_RESEARCH_TOPIC_MAX_LENGTH = 500;

export const RESEARCH_APPROVAL_WARNING =
  '批准后只启动资料发现；研究候选仍需单独批准才会导入并写入 Wiki。';

export const CANCEL_APPROVAL_WARNING =
  '批准后任务会被终止；运行中的模型调用会在取消轮询生效后中断。';

export const IMAGE_INSERT_APPROVAL_WARNING =
  '批准后才会生成一张图片并尝试插入正文；页面或选区变化会使任务安全失败。';

type ImageInsertPayload = Extract<
  WorkflowPreviewInput,
  { operation: 'workflow-image-insert-start' }
>['payload'];

function loadIllustratablePage(subject: Subject, slug: string): {
  slug: string;
  body: string;
} {
  const normalizedSlug = slug.trim();
  if (!isCanonicalPageSlug(normalizedSlug)) {
    throw new Error('page slug must be a non-empty canonical page slug');
  }
  const page = pagesRepo.getPageBySlug(subject.id, normalizedSlug);
  if (!page) throw new Error('Page not found in this subject.');
  if (pagesRepo.isMetaPage(page)) {
    throw new Error('Cannot insert an illustration into a protected system page.');
  }
  const document = readPageInSubject(subject.slug, normalizedSlug);
  if (!document) throw new Error('Page content not found in the vault.');
  return { slug: normalizedSlug, body: document.body };
}

async function imageInsertPreview(
  slug: string,
  anchor: PersistedMarkdownBlockAnchor,
  request: ImageGenerateInput,
): Promise<PendingActionPreview> {
  return {
    kind: 'workflow',
    preHead: await getVaultHead(),
    summary: `为 ${slug} 的选中内容生成配图`,
    affectedPages: [{ slug, action: 'update' }],
    diff: null,
    warnings: [IMAGE_INSERT_APPROVAL_WARNING],
    imageInsert: {
      selection: anchor.markdown,
      prompt: request.prompt,
      alt: request.alt,
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.style ? { style: request.style } : {}),
    },
  };
}

export async function prepareWorkflowImageInsert(
  subject: Subject,
  slug: string,
  selection: SelectionAnchorInput,
  request: ImageGenerateInput,
): Promise<{
  input: Extract<WorkflowPreviewInput, { operation: 'workflow-image-insert-start' }>;
  preview: PendingActionPreview;
}> {
  if (selection.sourceKind !== 'canonical') {
    throw new Error('Switch to Original before inserting an illustration.');
  }
  const normalizedRequest = ImageGenerateInputSchema.parse(request);
  const page = loadIllustratablePage(subject, slug);
  const anchor = createMarkdownBlockAnchor(page.body, selection);
  return {
    input: {
      operation: 'workflow-image-insert-start',
      payload: { slug: page.slug, anchor, request: normalizedRequest },
    },
    preview: await imageInsertPreview(page.slug, anchor, normalizedRequest),
  };
}

export async function planWorkflowImageInsert(
  subject: Subject,
  payload: ImageInsertPayload,
): Promise<PendingActionPreview> {
  const request = ImageGenerateInputSchema.parse(payload.request);
  const page = loadIllustratablePage(subject, payload.slug);
  resolveMarkdownBlockAnchor(page.body, payload.anchor);
  return imageInsertPreview(page.slug, payload.anchor, request);
}

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
