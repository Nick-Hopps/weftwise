/**
 * re-enrich 入队 helper（供对话工具循环触发）：校验目标页后入队 re-enrich 任务。
 * 校验逻辑抽成纯函数 validateReenrichTarget 便于单测；语义沿用原 /api/re-enrich route。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import * as queue from '../jobs/queue';
import { getVaultHead } from '../git/git-service';
import { META_PAGE_SLUGS } from '../wiki/page-identity';
import type { PendingActionPreview } from '@/lib/contracts';

export const REENRICH_APPROVAL_WARNING =
  '批准的是重新丰富任务，不是确定的内容变更；最终内容将在任务完成后通过历史记录审计。';

/** 纯校验：可入队返回 null，否则返回面向用户的错误消息。page=null 表示该 subject 下未找到。 */
export function validateReenrichTarget(
  slug: string,
  page: { tags: string[] } | null,
): string | null {
  if (META_PAGE_SLUGS.has(slug)) return 'Cannot re-enrich a meta page (index/log).';
  if (!page) return `Page "${slug}" not found in this subject.`;
  if (page.tags.includes('meta')) return 'Cannot re-enrich a meta page.';
  return null;
}

/** 校验目标页后入队 re-enrich 任务；校验失败抛 Error（消息可直接转述给用户）。 */
export function enqueueReenrich(subjectId: string, slug: string): { jobId: string } {
  const page = pagesRepo.getPageBySlug(subjectId, slug);
  const err = validateReenrichTarget(slug, page);
  if (err) throw new Error(err);
  const job = queue.enqueue('re-enrich', { slug, subjectId }, subjectId);
  return { jobId: job.id };
}

/** 只规划 re-enrich 调度动作，不创建 job。 */
export async function planReenrich(
  subjectId: string,
  slug: string,
): Promise<PendingActionPreview> {
  const page = pagesRepo.getPageBySlug(subjectId, slug);
  const error = validateReenrichTarget(slug, page);
  if (error) throw new Error(error);
  return {
    kind: 'workflow',
    preHead: await getVaultHead(),
    summary: `重新丰富页面 ${slug}`,
    affectedPages: [{ slug, action: 'update' }],
    diff: null,
    warnings: [REENRICH_APPROVAL_WARNING],
  };
}
