/**
 * 页面结构操作执行层（merge / split / delete / create）。
 * 把「LLM 生成内容 → 确定性拼装 frontmatter → relink 重链 → 单事务 Saga」抽成纯函数，
 * 供 merge/split/delete/create 任务包装层与 curate（页面策展）service、对话工具等复用。
 * 本层不 emit 事件、不触发向量回填——由调用方按各自语义处理。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from './wiki-store';
import { serializeWikiDocument } from './markdown';
import { serializeFrontmatter, stampSystemFrontmatter } from './frontmatter';
import { buildWikiPath } from './page-identity';
import { repointLinksToPage } from './relink';
import { planSplitPages } from './split-plan';
import { createChangeset, validateChangeset, applyChangeset } from './wiki-transaction';
import {
  applyPlannedPageOperation,
  planPageCreate,
  planPageDelete,
  planPagePatch,
  planPageUpdate,
} from './page-operation-plan';
import { generateStructuredOutput } from '../llm/provider-registry';
import { MergeResultSchema, MERGE_SYSTEM_PROMPT, buildMergeUserPrompt } from '../llm/prompts/merge-prompt';
import { SplitResultSchema, SPLIT_SYSTEM_PROMPT, buildSplitUserPrompt } from '../llm/prompts/split-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { ChangesetEntry, Subject, TitleResolver, WikiFrontmatter } from '@/lib/contracts';

export { applyPatchEdits } from './page-operation-plan';

function unionArr(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/** 把 source 融合进 target（target 存活），删除 source，本 subject 内指向 source 的引用全部重链到 target。 */
export async function executePageMerge(
  jobId: string,
  subject: Subject,
  params: { targetSlug: string; sourceSlug: string },
): Promise<{ mergedSlug: string; deletedSlug: string; referencesRepointed: number }> {
  const { targetSlug, sourceSlug } = params;
  if (targetSlug === sourceSlug) throw new Error('cannot merge a page into itself');

  const targetDoc = readPageInSubject(subject.slug, targetSlug);
  const sourceDoc = readPageInSubject(subject.slug, sourceSlug);
  if (!targetDoc) throw new Error(`target page "${targetSlug}" not found`);
  if (!sourceDoc) throw new Error(`source page "${sourceSlug}" not found`);

  const llm = await generateStructuredOutput(
    'merge',
    MergeResultSchema,
    MERGE_SYSTEM_PROMPT,
    buildMergeUserPrompt(
      { title: targetDoc.frontmatter.title, body: targetDoc.body },
      { title: sourceDoc.frontmatter.title, body: sourceDoc.body },
      {
        language: getWikiLanguage(),
        subject: { slug: subject.slug, name: subject.name, description: subject.description },
      },
    ),
  );

  const mergedFrontmatter: WikiFrontmatter = {
    ...targetDoc.frontmatter,
    title: targetDoc.frontmatter.title,
    tags: unionArr(targetDoc.frontmatter.tags, sourceDoc.frontmatter.tags),
    sources: unionArr(targetDoc.frontmatter.sources, sourceDoc.frontmatter.sources),
    summary: llm.mergedSummary,
  };
  const now = new Date().toISOString();
  let mergedContent = stampSystemFrontmatter(
    serializeFrontmatter(mergedFrontmatter, llm.mergedBody),
    { now, existingCreated: targetDoc.frontmatter.created },
  );

  const titleMap = pagesRepo.getTitleToSlugMap(subject.id);
  const resolver: TitleResolver = (t) => titleMap.get(t) ?? titleMap.get(t.toLowerCase());
  const targetTitle = targetDoc.frontmatter.title;

  mergedContent = repointLinksToPage(mergedContent, sourceSlug, targetTitle, subject.slug, resolver);

  const entries: ChangesetEntry[] = [
    { action: 'update', path: buildWikiPath(subject.slug, targetSlug), content: mergedContent },
    { action: 'delete', path: buildWikiPath(subject.slug, sourceSlug), content: null },
  ];

  let referencesRepointed = 0;
  const backlinks = pagesRepo
    .getBacklinks(subject.id, sourceSlug)
    .filter((b) => b.subjectId === subject.id && b.slug !== targetSlug && b.slug !== sourceSlug);
  for (const bl of backlinks) {
    const doc = readPageInSubject(subject.slug, bl.slug);
    if (!doc) continue;
    const raw = serializeWikiDocument(doc);
    const rewritten = repointLinksToPage(raw, sourceSlug, targetTitle, subject.slug, resolver);
    if (rewritten !== raw) {
      entries.push({ action: 'update', path: buildWikiPath(subject.slug, bl.slug), content: rewritten });
      referencesRepointed += 1;
    }
  }

  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`merge changeset invalid: ${validation.errors.join('; ')}`);
  await applyChangeset(changeset);

  return { mergedSlug: targetSlug, deletedSlug: sourceSlug, referencesRepointed };
}

/** 把 source 页 LLM 拆成 N 个独立新页（标恰一主承接页），删除 source，本 subject 内指向 source 的引用统一重指主页。 */
export async function executePageSplit(
  jobId: string,
  subject: Subject,
  params: { sourceSlug: string; hint?: string },
): Promise<{ sourceSlug: string; pageSlugs: string[]; primarySlug: string; referencesRepointed: number }> {
  const { sourceSlug, hint } = params;
  const sourceDoc = readPageInSubject(subject.slug, sourceSlug);
  if (!sourceDoc) throw new Error(`source page "${sourceSlug}" not found`);

  const llm = await generateStructuredOutput(
    'split',
    SplitResultSchema,
    SPLIT_SYSTEM_PROMPT,
    buildSplitUserPrompt(
      { title: sourceDoc.frontmatter.title, body: sourceDoc.body },
      hint,
      {
        language: getWikiLanguage(),
        subject: { slug: subject.slug, name: subject.name, description: subject.description },
      },
    ),
  );
  if (llm.pages.length < 2) throw new Error('split must produce at least 2 pages');

  const existingSlugs = new Set(pagesRepo.getAllPages(subject.id).map((p) => p.slug));
  const planned = planSplitPages(llm.pages, existingSlugs, sourceSlug);
  const primary = planned.find((p) => p.isPrimary) ?? planned[0];

  const titleMap = pagesRepo.getTitleToSlugMap(subject.id);
  const resolver: TitleResolver = (t) => titleMap.get(t) ?? titleMap.get(t.toLowerCase());
  const now = new Date().toISOString();

  const entries: ChangesetEntry[] = [];
  for (const p of planned) {
    const body = repointLinksToPage(p.body, sourceSlug, primary.title, subject.slug, resolver);
    const frontmatter: WikiFrontmatter = {
      title: p.title,
      created: sourceDoc.frontmatter.created,
      updated: now,
      tags: sourceDoc.frontmatter.tags,
      sources: sourceDoc.frontmatter.sources,
      summary: p.summary,
    };
    const content = stampSystemFrontmatter(serializeFrontmatter(frontmatter, body), {
      now,
      existingCreated: sourceDoc.frontmatter.created,
    });
    entries.push({ action: 'create', path: buildWikiPath(subject.slug, p.slug), content });
  }

  entries.push({ action: 'delete', path: buildWikiPath(subject.slug, sourceSlug), content: null });

  let referencesRepointed = 0;
  const backlinks = pagesRepo
    .getBacklinks(subject.id, sourceSlug)
    .filter((b) => b.subjectId === subject.id && b.slug !== sourceSlug);
  for (const bl of backlinks) {
    const doc = readPageInSubject(subject.slug, bl.slug);
    if (!doc) continue;
    const raw = serializeWikiDocument(doc);
    const rewritten = repointLinksToPage(raw, sourceSlug, primary.title, subject.slug, resolver);
    if (rewritten !== raw) {
      entries.push({ action: 'update', path: buildWikiPath(subject.slug, bl.slug), content: rewritten });
      referencesRepointed += 1;
    }
  }

  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`split changeset invalid: ${validation.errors.join('; ')}`);
  await applyChangeset(changeset);

  return { sourceSlug, pageSlugs: planned.map((p) => p.slug), primarySlug: primary.slug, referencesRepointed };
}

/**
 * 删除一页：构造 delete changeset → validate → apply。
 * 返回删除 slug + 删后变坏链的入站引用数（本 subject，排除自引用）。不 emit / 不 enqueue。
 * 调用方需先校验目标合法（保护页/存在性，见 services/page-write.ts::validateDeleteTarget）。
 */
export async function executePageDelete(
  jobId: string,
  subject: Subject,
  slug: string,
): Promise<{ deletedSlug: string; brokenBacklinks: number }> {
  const plan = await planPageDelete(jobId, subject, {
    slug,
    effectiveAt: new Date().toISOString(),
  });
  const result = await applyPlannedPageOperation(plan);
  return { deletedSlug: result.deletedSlug, brokenBacklinks: result.brokenBacklinks };
}

/**
 * 新建一页：title 派生唯一 slug（`deriveUniqueSlug`，排除本 subject 已有 slug）→ 确定性拼
 * frontmatter（系统拥有 created/updated/sources）→ create changeset → validate（拦坏链）→ apply。
 * 不 emit / 不 enqueue。
 */
export async function executePageCreate(
  jobId: string,
  subject: Subject,
  input: { title: string; body: string; summary?: string; tags?: string[] },
): Promise<{ createdSlug: string }> {
  const plan = await planPageCreate(jobId, subject, {
    ...input,
    effectiveAt: new Date().toISOString(),
  });
  const result = await applyPlannedPageOperation(plan);
  return { createdSlug: result.createdSlug };
}

/**
 * 更新一页（可选改标题）：替换正文、覆盖 tags/summary；改标题时联动重写本 subject 内
 * 引用该页旧标题的文本（relink.ts::rewriteBacklinkText），与原页更新同一个 Saga 事务提交。
 * 坏链铁律：!valid（跨主题坏链 errors）或留下**页面自身** entry 的 unresolved-wikilink
 * 警告一律抛错、不落盘（单页更新里残留 unresolved-wikilink 等同坏链；引导调用方「先建目标页再链接」）；
 * 该检查只看被更新页面自身 entry 的 path，不含改标题时自动生成的 backlink 重写 entry——
 * 后者是机械重写产生、必然指向真实存在页面的文本，validateChangeset 在没有感知 pending rename
 * 的情况下会误判为未解析（normalizeSlug 后既不匹配未变的 slug，也不匹配尚未落盘的新标题），
 * 不应据此拒绝整个改标题操作。
 * 供 fix tool-loop 与对话式 wiki.update（fix + query 两个 runner）复用。
 */
export async function executePageUpdate(
  jobId: string,
  subject: Subject,
  params: { slug: string; title?: string; body: string; summary?: string; tags?: string[] },
): Promise<{ updatedSlug: string; referencesUpdated: number }> {
  const plan = await planPageUpdate(jobId, subject, {
    ...params,
    effectiveAt: new Date().toISOString(),
  });
  const result = await applyPlannedPageOperation(plan);
  return { updatedSlug: result.updatedSlug, referencesUpdated: result.referencesUpdated };
}

/**
 * 局部更新一页正文：edits 逐组精确唯一替换（applyPatchEdits），拼出完整新正文后
 * 委托 executePageUpdate 走 Saga——坏链校验/unresolved-wikilink 拒绝/updated 时间戳
 * /单 git commit 全部继承。只动 body；title/tags/summary 走 executePageUpdate。
 */
export async function executePagePatch(
  jobId: string,
  subject: Subject,
  params: { slug: string; edits: Array<{ oldString: string; newString: string }> },
): Promise<{ updatedSlug: string; appliedEdits: number }> {
  const plan = await planPagePatch(jobId, subject, {
    ...params,
    effectiveAt: new Date().toISOString(),
  });
  const result = await applyPlannedPageOperation(plan);
  return { updatedSlug: result.updatedSlug, appliedEdits: result.appliedEdits };
}
