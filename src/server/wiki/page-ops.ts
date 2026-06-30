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
import { buildWikiPath, deriveUniqueSlug } from './page-identity';
import { repointLinksToPage } from './relink';
import { planSplitPages } from './split-plan';
import { createChangeset, validateChangeset, applyChangeset } from './wiki-transaction';
import { generateStructuredOutput } from '../llm/provider-registry';
import { MergeResultSchema, MERGE_SYSTEM_PROMPT, buildMergeUserPrompt } from '../llm/prompts/merge-prompt';
import { SplitResultSchema, SPLIT_SYSTEM_PROMPT, buildSplitUserPrompt } from '../llm/prompts/split-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { ChangesetEntry, Subject, TitleResolver, WikiFrontmatter } from '@/lib/contracts';

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
  // getBacklinks 已排除 meta 源页（pages-repo 内部过滤），故 brokenBacklinks 仅计内容页的入站链接。
  const brokenBacklinks = pagesRepo
    .getBacklinks(subject.id, slug)
    .filter((b) => b.slug !== slug).length;

  const entries: ChangesetEntry[] = [
    { action: 'delete', path: buildWikiPath(subject.slug, slug), content: null },
  ];
  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`delete changeset invalid: ${validation.errors.join('; ')}`);
  await applyChangeset(changeset);

  return { deletedSlug: slug, brokenBacklinks };
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
  const existing = new Set(pagesRepo.getAllPages(subject.id).map((p) => p.slug));
  const slug = deriveUniqueSlug(input.title, existing);

  const now = new Date().toISOString();
  const frontmatter: WikiFrontmatter = {
    title: input.title,
    created: now,
    updated: now,
    tags: input.tags ?? [],
    sources: [],
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  };
  const content = serializeFrontmatter(frontmatter, input.body);

  const entries: ChangesetEntry[] = [
    { action: 'create', path: buildWikiPath(subject.slug, slug), content },
  ];
  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`create changeset invalid: ${validation.errors.join('; ')}`);
  await applyChangeset(changeset);

  return { createdSlug: slug };
}
