/**
 * Merge service — 任务类型 'merge'。
 * 把 source 页融合进 target 页（LLM 产正文+摘要），删除 source，并把本 subject 内
 * 所有解析到 source 的 [[…]] 引用重链到 target。单次结构化 LLM + 确定性 Saga。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('merge', ...)。
 */
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { serializeWikiDocument } from '../wiki/markdown';
import { serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import { buildWikiPath } from '../wiki/page-identity';
import { repointLinksToPage } from '../wiki/relink';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../wiki/wiki-transaction';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  MergeResultSchema,
  MERGE_SYSTEM_PROMPT,
  buildMergeUserPrompt,
} from '../llm/prompts/merge-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { Job, ChangesetEntry, TitleResolver, WikiFrontmatter } from '@/lib/contracts';

interface MergeParams {
  targetSlug?: string;
  sourceSlug?: string;
  subjectId?: string;
}

function unionArr(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

async function runMergeJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as MergeParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('merge job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const { targetSlug, sourceSlug } = params;
  if (!targetSlug || !sourceSlug) throw new Error('merge job missing targetSlug/sourceSlug');
  if (targetSlug === sourceSlug) throw new Error('cannot merge a page into itself');

  const targetDoc = readPageInSubject(subject.slug, targetSlug);
  const sourceDoc = readPageInSubject(subject.slug, sourceSlug);
  if (!targetDoc) throw new Error(`target page "${targetSlug}" not found`);
  if (!sourceDoc) throw new Error(`source page "${sourceSlug}" not found`);

  emit('merge:start', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });

  // 1. LLM 融合正文 + 摘要
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

  // 2. 确定性拼装 A 的新 frontmatter（title/created 保 A，tags/sources 取并集，summary 用 LLM）
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

  // 3. 重链：把所有解析到 source 的引用改指 target（合并体自身 + 本 subject backlink 源页）
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

  // 4. 单事务 Saga
  const changeset = createChangeset(job.id, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    throw new Error(`merge changeset invalid: ${validation.errors.join('; ')}`);
  }
  await applyChangeset(changeset);

  emit(
    'merge:complete',
    `Merged into "${targetSlug}"; repointed ${referencesRepointed} reference(s)`,
    { mergedSlug: targetSlug, deletedSlug: sourceSlug, referencesRepointed },
  );

  // 写后触发向量回填（未配置 embedding 时 no-op）
  enqueueEmbedIndex(subject.id);

  return { mergedSlug: targetSlug, deletedSlug: sourceSlug, referencesRepointed };
}

registerHandler('merge', runMergeJob);
