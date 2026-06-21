/**
 * Split service — 任务类型 'split'。
 * 把 source 页 LLM 拆成 N 个独立新页（标出主承接页），删除 source，并把本 subject 内
 * 所有解析到 source 的 [[…]] 引用统一重指主页。单次结构化 LLM + 确定性 Saga。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('split', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { serializeWikiDocument } from '../wiki/markdown';
import { serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import { buildWikiPath } from '../wiki/page-identity';
import { repointLinksToPage } from '../wiki/relink';
import { planSplitPages } from '../wiki/split-plan';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../wiki/wiki-transaction';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  SplitResultSchema,
  SPLIT_SYSTEM_PROMPT,
  buildSplitUserPrompt,
} from '../llm/prompts/split-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { Job, ChangesetEntry, TitleResolver, WikiFrontmatter } from '@/lib/contracts';

interface SplitParams {
  sourceSlug?: string;
  hint?: string;
  subjectId?: string;
}

async function runSplitJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as SplitParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('split job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const { sourceSlug, hint } = params;
  if (!sourceSlug) throw new Error('split job missing sourceSlug');

  const sourceDoc = readPageInSubject(subject.slug, sourceSlug);
  if (!sourceDoc) throw new Error(`source page "${sourceSlug}" not found`);

  emit('split:start', `Splitting "${sourceSlug}"…`, { sourceSlug });

  // 1. LLM 拆分
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

  // 2. 派生唯一 slug + 恰一 primary
  const existingSlugs = new Set(pagesRepo.getAllPages(subject.id).map((p) => p.slug));
  const planned = planSplitPages(llm.pages, existingSlugs, sourceSlug);
  const primary = planned.find((p) => p.isPrimary) ?? planned[0];

  // 3. resolver（合并前，A 仍在库，能解析到 sourceSlug）
  const titleMap = pagesRepo.getTitleToSlugMap(subject.id);
  const resolver: TitleResolver = (t) => titleMap.get(t) ?? titleMap.get(t.toLowerCase());
  const now = new Date().toISOString();

  // 4. 新页 create 条目（正文里指向 A 的自引用重指主页）
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

  // 5. 删 A
  entries.push({ action: 'delete', path: buildWikiPath(subject.slug, sourceSlug), content: null });

  // 6. 本 subject 内指向 A 的引用页统一重指主页
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

  // 7. 单事务 Saga
  const changeset = createChangeset(job.id, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    throw new Error(`split changeset invalid: ${validation.errors.join('; ')}`);
  }
  await applyChangeset(changeset);

  const pageSlugs = planned.map((p) => p.slug);
  emit('split:complete', `Split into ${pageSlugs.length} pages; repointed ${referencesRepointed} reference(s)`, {
    sourceSlug,
    pageSlugs,
    primarySlug: primary.slug,
    referencesRepointed,
  });

  return { sourceSlug, pageSlugs, primarySlug: primary.slug, referencesRepointed };
}

registerHandler('split', runSplitJob);
