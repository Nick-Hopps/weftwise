/**
 * T1.8 — re-enrich 质量信号取数（IO 层，确定性、零额外 LLM 调用）。
 *
 * 与 lint-service 的全库扫描分离：这里只对「本次 re-enrich 的这一页」做轻量检查，
 * 供 maintenance-policy 的 qualityDelta / staleSource 输入使用，避免为一次 re-enrich
 * 触发全库 lint。
 */
import type { Subject } from '@/lib/contracts';
import * as pagesRepo from '../db/repos/pages-repo';
import { parseFrontmatter, validateFrontmatter } from '../wiki/frontmatter';
import { extractWikiLinks } from '../wiki/wikilinks';
import { checkStaleSourcesForPage } from './lint-deterministic';

/**
 * 单页确定性 findings 计数：
 *   - frontmatter 缺失/非法 → +1；
 *   - 本页正文里指向本 subject 内不存在页面的出链 → 每条 +1。
 * 跨主题链接不在此校验（需要跨库查，属全库 lint 的职责，这里刻意不做）。
 */
export function countPageDeterministicFindings(opts: {
  subjectId: string;
  pageSlug: string;
  content: string;
}): number {
  const { subjectId, pageSlug, content } = opts;
  let count = 0;

  const { data } = parseFrontmatter(content);
  const validation = validateFrontmatter(data as unknown as Record<string, unknown>);
  if (!validation.valid) count += 1;

  const allPages = pagesRepo.getAllPages(subjectId);
  const slugSet = new Set(allPages.map((p) => p.slug));
  slugSet.add(pageSlug); // 本页自身（新建场景可能尚未落库）不误判为坏链目标

  for (const link of extractWikiLinks(content)) {
    if (link.targetSubjectSlug) continue; // 跨主题链接跳过
    if (!slugSet.has(link.target)) count += 1;
  }

  return count;
}

/** 该页关联 sources 是否存在 stale（复用 lint-deterministic 的单页判定，不跑全库扫描）。*/
export function pageHasStaleSources(subject: Subject, pageSlug: string): boolean {
  const page = pagesRepo.getPageBySlug(subject.id, pageSlug);
  if (!page) return false;
  return checkStaleSourcesForPage(subject, page).length > 0;
}
