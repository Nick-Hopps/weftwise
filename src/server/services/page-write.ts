/**
 * 页面写操作的对话路径包装（供 query 工具循环调用）。
 * 删除规则纯函数化（validateDeleteTarget，路由与对话单一来源），执行复用
 * wiki/page-ops 内核，写后触发向量回填。update 额外过忠实度护栏（复用 fix 同档）。
 * 语义沿用 DELETE /api/pages 路由 + executePageCreate/executePageUpdate。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { executePageDelete, executePageCreate, executePageUpdate } from '../wiki/page-ops';
import { readPageInSubject } from '../wiki/wiki-store';
import { checkRewriteFidelity, FIDELITY_PROFILES } from '../wiki/rewrite-fidelity';
import { enqueueEmbedIndex } from './embedding-service';
import { META_PAGE_SLUGS } from '../wiki/page-identity';
import type { Subject } from '@/lib/contracts';

/** 纯校验：可删返回 null，否则返回面向用户的错误消息。page=null 表示该 subject 下未找到。 */
export function validateDeleteTarget(
  slug: string,
  page: { tags: string[] } | null,
): string | null {
  if (META_PAGE_SLUGS.has(slug)) return `Cannot delete protected system page "${slug}".`;
  if (!page) return `Page "${slug}" not found in this subject.`;
  if (page.tags.includes('meta')) return `Cannot delete meta page "${slug}".`;
  return null;
}

/** 校验目标页后同步删除（Saga）+ 触发向量 prune；校验失败抛 Error（消息可直接转述）。 */
export async function deletePageInSubject(
  subject: Subject,
  slug: string,
): Promise<{ deletedSlug: string; brokenBacklinks: number }> {
  const page = pagesRepo.getPageBySlug(subject.id, slug);
  const err = validateDeleteTarget(slug, page);
  if (err) throw new Error(err);
  const result = await executePageDelete(crypto.randomUUID(), subject, slug);
  enqueueEmbedIndex(subject.id);
  return result;
}

/** 同步新建一页（Saga）+ 触发向量回填；title 派生唯一 slug（永不冲突）。 */
export async function createPageInSubject(
  subject: Subject,
  input: { title: string; body: string; summary?: string; tags?: string[] },
): Promise<{ createdSlug: string }> {
  const title = input.title?.trim();
  if (!title) throw new Error('A page title is required.');
  const result = await executePageCreate(crypto.randomUUID(), subject, {
    ...input,
    title,
    body: input.body ?? '',
  });
  enqueueEmbedIndex(subject.id);
  return result;
}

/**
 * 校验目标页存在 + 非保护页 + 忠实度护栏（FIDELITY_PROFILES.fix：正文不得缩水到原文
 * 80% 以下、不得丢失原有 wikilink）后同步更新（Saga，可选改标题联动 relink）+ 触发
 * 向量回填。校验/护栏失败抛 Error（消息可直接转述）。
 * 保护页（index/log）与 deletePageInSubject/fix 的 wiki.update 对齐，防止对话式
 * wiki_update 覆盖确定性渲染的系统元页。
 */
export async function updatePageInSubject(
  subject: Subject,
  input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] },
): Promise<{ updatedSlug: string; referencesUpdated: number }> {
  if (META_PAGE_SLUGS.has(input.slug)) {
    throw new Error(`Cannot update protected system page "${input.slug}".`);
  }
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`Page "${input.slug}" not found in this subject.`);
  const fidelity = checkRewriteFidelity(doc.body, input.body, FIDELITY_PROFILES.fix);
  if (!fidelity.ok) {
    throw new Error(`Edit dropped too much content: ${fidelity.violations.join('; ')}`);
  }
  const result = await executePageUpdate(crypto.randomUUID(), subject, input);
  enqueueEmbedIndex(subject.id);
  return result;
}
