/**
 * 页面写操作的对话路径包装（供 query 工具循环调用）。
 * 删除规则纯函数化（validateDeleteTarget，路由与对话单一来源），执行复用
 * wiki/page-ops 内核，写后触发向量回填。update 额外过忠实度护栏（复用 fix 同档）。
 * 语义沿用 DELETE /api/pages 路由 + executePageCreate/executePageUpdate。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import {
  executePageCreate,
  executePageDelete,
  executePageLinkEnsure,
  executePageMetadataPatch,
  executePagePatch,
  executePageUpdate,
} from '../wiki/page-ops';
import {
  planPageCreate,
  planPageDelete,
  planPageLinkEnsure,
  planPageMetadataPatch,
  planPageMove,
  planPagePatch,
  planTagBatch,
  planPageUpdate,
  type PlannedPageOperation,
} from '../wiki/page-operation-plan';
import { readPageInSubject } from '../wiki/wiki-store';
import { checkRewriteFidelity, collectMissingLinkTargets, FIDELITY_PROFILES } from '../wiki/rewrite-fidelity';
import { enqueueEmbedIndex } from './embedding-service';
import { META_PAGE_SLUGS, normalizeSlug } from '../wiki/page-identity';
import * as subjectsRepo from '../db/repos/subjects-repo';
import type {
  LinkEnsureInput,
  LinkEnsureResult,
  MetadataPatchInput,
  MetadataPatchResult,
  TagBatchInput,
  TagBatchResult,
  Subject,
} from '@/lib/contracts';

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

export async function planDeletePageInSubject(
  subject: Subject,
  slug: string,
  effectiveAt: string,
): Promise<PlannedPageOperation<{ deletedSlug: string; brokenBacklinks: number }>> {
  const page = pagesRepo.getPageBySlug(subject.id, slug);
  const error = validateDeleteTarget(slug, page);
  if (error) throw new Error(error);
  return planPageDelete(crypto.randomUUID(), subject, { slug, effectiveAt });
}

export async function planMovePageInSubject(
  subject: Subject,
  input: { slug: string; newSlug: string },
  effectiveAt: string,
) {
  return planPageMove(crypto.randomUUID(), subject, { ...input, effectiveAt });
}

/** 校验目标页后同步删除（Saga）+ 触发向量 prune；校验失败抛 Error（消息可直接转述）。 */
export async function deletePageInSubject(
  subject: Subject,
  slug: string,
): Promise<{ deletedSlug: string; brokenBacklinks: number }> {
  const page = pagesRepo.getPageBySlug(subject.id, slug);
  const error = validateDeleteTarget(slug, page);
  if (error) throw new Error(error);
  const result = await executePageDelete(crypto.randomUUID(), subject, slug);
  enqueueEmbedIndex(subject.id);
  return result;
}

export async function planCreatePageInSubject(
  subject: Subject,
  input: { title: string; body: string; summary?: string; tags?: string[] },
  effectiveAt: string,
): Promise<PlannedPageOperation<{ createdSlug: string }>> {
  const title = input.title?.trim();
  if (!title) throw new Error('A page title is required.');
  return planPageCreate(crypto.randomUUID(), subject, {
    ...input,
    title,
    body: input.body ?? '',
    effectiveAt,
  });
}

export interface CreatePageCommandOptions {
  /** worker 调用传真实 job ID；同步工具调用省略时生成独立 operation 关联 ID。 */
  jobId?: string;
}

/** 同步新建一页（Saga）+ 触发向量回填；title 派生唯一 slug（永不冲突）。 */
export async function createPageInSubject(
  subject: Subject,
  input: { title: string; body: string; summary?: string; tags?: string[] },
  options: CreatePageCommandOptions = {},
): Promise<{ createdSlug: string }> {
  const title = input.title?.trim();
  if (!title) throw new Error('A page title is required.');
  const result = await executePageCreate(options.jobId ?? crypto.randomUUID(), subject, {
    ...input,
    title,
    body: input.body ?? '',
  });
  enqueueEmbedIndex(subject.id);
  return result;
}

/**
 * 计算正文中已确认断链的 wikilink targetKey 集合，作忠实度 preserve 规则的豁免集——
 * 修断链（解链/重链）本质上要丢弃这些目标，不豁免则修复被护栏确定性拒绝。
 * 同 subject：目标 slug ∈（页 slug 集 ∪ normalizeSlug(title) 集）即视为存在
 * （无 titleResolver 时 extractWikiLinks 把 [[Title]] 归一为 slugFromTitle，与页
 * 真实 slug 可能不一致，并入 title 派生形防止误豁免活链）；跨 subject：逐条查目标页。
 */
export function collectBrokenLinkTargets(subject: Subject, body: string): Set<string> {
  const known = new Set<string>();
  for (const p of pagesRepo.getAllPages(subject.id)) {
    known.add(p.slug);
    known.add(normalizeSlug(p.title));
  }
  return collectMissingLinkTargets(body, (targetSubjectSlug, targetSlug) => {
    if (!targetSubjectSlug || targetSubjectSlug === subject.slug) return known.has(targetSlug);
    const target = subjectsRepo.getBySlug(targetSubjectSlug);
    return target ? Boolean(pagesRepo.getPageBySlug(target.id, targetSlug)) : false;
  });
}

export async function planUpdatePageInSubject(
  subject: Subject,
  input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] },
  effectiveAt: string,
): Promise<PlannedPageOperation<{ updatedSlug: string; referencesUpdated: number }>> {
  if (META_PAGE_SLUGS.has(input.slug)) {
    throw new Error(`Cannot update protected system page "${input.slug}".`);
  }
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`Page "${input.slug}" not found in this subject.`);
  const fidelity = checkRewriteFidelity(doc.body, input.body, FIDELITY_PROFILES.fix, {
    allowedDroppedTargets: collectBrokenLinkTargets(subject, doc.body),
  });
  if (!fidelity.ok) {
    throw new Error(`Edit dropped too much content: ${fidelity.violations.join('; ')}`);
  }
  return planPageUpdate(crypto.randomUUID(), subject, { ...input, effectiveAt });
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
  const fidelity = checkRewriteFidelity(doc.body, input.body, FIDELITY_PROFILES.fix, {
    allowedDroppedTargets: collectBrokenLinkTargets(subject, doc.body),
  });
  if (!fidelity.ok) {
    throw new Error(`Edit dropped too much content: ${fidelity.violations.join('; ')}`);
  }
  const result = await executePageUpdate(crypto.randomUUID(), subject, input);
  enqueueEmbedIndex(subject.id);
  return result;
}

function assertMetadataPatchTarget(slug: string): void {
  if (META_PAGE_SLUGS.has(slug)) {
    throw new Error(`Cannot update protected system page "${slug}".`);
  }
}

/** 只生成 metadata 计划；不 apply、不触发向量回填。 */
export async function planMetadataPatchInSubject(
  subject: Subject,
  input: MetadataPatchInput,
  effectiveAt: string,
): Promise<PlannedPageOperation<MetadataPatchResult>> {
  assertMetadataPatchTarget(input.slug);
  return planPageMetadataPatch(crypto.randomUUID(), subject, { ...input, effectiveAt });
}

/** Tags 工作台只创建批量治理计划，实际 apply 必须由 PendingAction 批准消费。 */
export async function planTagBatchInSubject(
  subject: Subject,
  input: TagBatchInput,
  effectiveAt: string,
): Promise<PlannedPageOperation<TagBatchResult>> {
  return planTagBatch(crypto.randomUUID(), subject, { ...input, effectiveAt });
}

/**
 * 校验非系统现有页后执行 metadata 窄写；alias 冲突由共享 planner 校验。
 * direct 成功后由本入口唯一触发一次向量回填。
 */
export async function patchMetadataInSubject(
  subject: Subject,
  input: MetadataPatchInput,
): Promise<MetadataPatchResult> {
  assertMetadataPatchTarget(input.slug);
  const result = await executePageMetadataPatch(crypto.randomUUID(), subject, input);
  enqueueEmbedIndex(subject.id);
  return result;
}

function assertLinkEnsureSource(sourceSlug: string): void {
  if (META_PAGE_SLUGS.has(sourceSlug)) {
    throw new Error(`Cannot update protected system page "${sourceSlug}".`);
  }
}

/** 只生成 wikilink 窄写计划；source 保护后完全委托共享 planner。 */
export async function planLinkEnsureInSubject(
  subject: Subject,
  input: LinkEnsureInput,
  effectiveAt: string,
): Promise<PlannedPageOperation<LinkEnsureResult>> {
  assertLinkEnsureSource(input.sourceSlug);
  return planPageLinkEnsure(crypto.randomUUID(), subject, { ...input, effectiveAt });
}

/**
 * 执行 wikilink 窄写；只保护 source 系统页，target 是否存在由共享 planner 按 mode 校验。
 * direct 成功后由本入口唯一触发一次向量回填。
 */
export async function ensureLinkInSubject(
  subject: Subject,
  input: LinkEnsureInput,
): Promise<LinkEnsureResult> {
  assertLinkEnsureSource(input.sourceSlug);
  const result = await executePageLinkEnsure(crypto.randomUUID(), subject, input);
  enqueueEmbedIndex(subject.id);
  return result;
}

export async function planPatchPageInSubject(
  subject: Subject,
  input: { slug: string; edits: Array<{ oldString: string; newString: string }> },
  effectiveAt: string,
): Promise<PlannedPageOperation<{ updatedSlug: string; appliedEdits: number }>> {
  if (META_PAGE_SLUGS.has(input.slug)) {
    throw new Error(`Cannot update protected system page "${input.slug}".`);
  }
  return planPagePatch(crypto.randomUUID(), subject, { ...input, effectiveAt });
}

/**
 * 局部更新一页正文（对话/fix 工具路径包装）：META 保护页拒绝后委托 executePagePatch
 * （edits 精确唯一替换 + Saga）+ 触发向量回填。
 * 刻意不接忠实度护栏：patch 是确定性拼接，未被 edits 提到的内容不可能变；
 * unresolved-wikilink 校验由内核委托的 executePageUpdate 继承（新增链接必须可解析）。
 */
export async function patchPageInSubject(
  subject: Subject,
  input: { slug: string; edits: Array<{ oldString: string; newString: string }> },
): Promise<{ updatedSlug: string; appliedEdits: number }> {
  if (META_PAGE_SLUGS.has(input.slug)) {
    throw new Error(`Cannot update protected system page "${input.slug}".`);
  }
  const result = await executePagePatch(crypto.randomUUID(), subject, input);
  enqueueEmbedIndex(subject.id);
  return result;
}
