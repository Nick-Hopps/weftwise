/**
 * Curate service — 任务类型 'curate'：agent 驱动的页面策展。
 * 两段式：triage（只读元数据收窄候选）→ confirm（逐候选取正文确认）→ 执行（复用 page-ops）。
 * 每条 merge/split 各自一个 Saga commit（⑥ 历史可逐条 revert）。
 * params: { scope: 'pages' | 'subject'; slugs?: string[]; subjectId }
 *  - 'pages'：scope = slugs（本次 ingest 受影响页）+ 本-subject 邻居（自动路径）。
 *  - 'subject'：scope = 全 subject 非 meta 页（手动路径）。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('curate', ...)。
 */
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { executePageMerge, executePageSplit } from '../wiki/page-ops';
import { expandScopeWithNeighbors, applyDecisionCaps, restrictToSeed, type CurateLimits } from '../wiki/curate-plan';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  CurateTriageSchema,
  CURATE_TRIAGE_SYSTEM_PROMPT,
  buildCurateTriageUserPrompt,
  CurateMergeConfirmSchema,
  CURATE_MERGE_CONFIRM_SYSTEM_PROMPT,
  buildCurateMergeConfirmUserPrompt,
  CurateSplitConfirmSchema,
  CURATE_SPLIT_CONFIRM_SYSTEM_PROMPT,
  buildCurateSplitConfirmUserPrompt,
  type CurateMergeConfirm,
  type CurateSplitConfirm,
} from '../llm/prompts/curate-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { Job } from '@/lib/contracts';

const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);
const LIMITS: CurateLimits = { maxMerges: 5, maxSplits: 5 };

interface CurateParams {
  scope?: 'pages' | 'subject';
  slugs?: string[];
  subjectId?: string;
}

async function runCurateJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as CurateParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('curate job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const promptCtx = {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };

  // 1. 解析 scope
  let scopeSlugs: string[];
  let seedSet: Set<string> | null;
  if (params.scope === 'pages' && Array.isArray(params.slugs)) {
    const seed = params.slugs.filter((s) => !PROTECTED_SYSTEM_PAGES.has(s));
    seedSet = new Set(seed);
    const links = pagesRepo.getAllLinks(subject.id);
    scopeSlugs = expandScopeWithNeighbors(seed, links, subject.id, PROTECTED_SYSTEM_PAGES);
  } else {
    seedSet = null;
    scopeSlugs = pagesRepo
      .getAllPages(subject.id)
      .map((p) => p.slug)
      .filter((s) => !PROTECTED_SYSTEM_PAGES.has(s));
  }

  emit('curate:start', `Curating ${scopeSlugs.length} page(s) in "${subject.slug}"…`, {
    scope: params.scope ?? 'subject',
    count: scopeSlugs.length,
  });

  if (scopeSlugs.length < 2) {
    emit('curate:complete', 'Nothing to curate (need at least 2 pages).', { merges: 0, splits: 0 });
    return { merges: 0, splits: 0, referencesRepointed: 0, skipped: 0 };
  }

  // 2. 收集元数据（读正文取字数，不把正文喂给 triage）
  const metas: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[] = [];
  for (const slug of scopeSlugs) {
    const doc = readPageInSubject(subject.slug, slug);
    if (!doc) continue;
    metas.push({
      slug,
      title: doc.frontmatter.title,
      summary: doc.frontmatter.summary ?? '',
      tags: doc.frontmatter.tags ?? [],
      bodyChars: doc.body.length,
    });
  }

  // 3. triage
  const triage = await generateStructuredOutput(
    'curate',
    CurateTriageSchema,
    CURATE_TRIAGE_SYSTEM_PROMPT,
    buildCurateTriageUserPrompt(metas, promptCtx),
  );
  const normalizedTriage = { merges: triage.merges ?? [], splits: triage.splits ?? [] };

  // FIX 1：auto 路径（scope:'pages'）先过 seed 护栏，再截上限
  const { kept: seedKept, droppedMerges: seedDroppedMerges, droppedSplits: seedDroppedSplits } = restrictToSeed(
    normalizedTriage,
    seedSet,
  );
  for (const m of seedDroppedMerges) {
    emit('curate:skip', `Skip merge ${m.aSlug}+${m.bSlug}: does not involve a changed page.`, { ...m });
  }
  for (const s of seedDroppedSplits) {
    emit('curate:skip', `Skip split ${s.slug}: does not involve a changed page.`, { ...s });
  }

  const { kept, droppedMerges, droppedSplits } = applyDecisionCaps(seedKept, LIMITS);
  if (droppedMerges > 0 || droppedSplits > 0) {
    emit('curate:warn', `Capped over-limit decisions: dropped ${droppedMerges} merge(s) / ${droppedSplits} split(s).`, {
      droppedMerges,
      droppedSplits,
    });
  }
  emit('curate:plan', `Plan: ${kept.merges.length} merge candidate(s), ${kept.splits.length} split candidate(s).`, {
    merges: kept.merges.length,
    splits: kept.splits.length,
  });

  let merges = 0;
  let splits = 0;
  let referencesRepointed = 0;
  let skipped = 0;

  // 4. merge 候选：逐条重校验 + confirm + 执行
  for (const cand of kept.merges) {
    const aDoc = readPageInSubject(subject.slug, cand.aSlug);
    const bDoc = readPageInSubject(subject.slug, cand.bSlug);
    if (
      !aDoc ||
      !bDoc ||
      cand.aSlug === cand.bSlug ||
      PROTECTED_SYSTEM_PAGES.has(cand.aSlug) ||
      PROTECTED_SYSTEM_PAGES.has(cand.bSlug)
    ) {
      skipped += 1;
      emit('curate:skip', `Skip merge ${cand.aSlug}+${cand.bSlug} (stale/invalid).`, { ...cand });
      continue;
    }
    // FIX 2：confirm LLM 瞬时错误不中止整个 pass，跳过此候选继续
    let confirm: CurateMergeConfirm;
    try {
      confirm = await generateStructuredOutput(
        'curate',
        CurateMergeConfirmSchema,
        CURATE_MERGE_CONFIRM_SYSTEM_PROMPT,
        buildCurateMergeConfirmUserPrompt(
          { slug: cand.aSlug, title: aDoc.frontmatter.title, body: aDoc.body },
          { slug: cand.bSlug, title: bDoc.frontmatter.title, body: bDoc.body },
          promptCtx,
        ),
      );
    } catch (err) {
      skipped += 1;
      emit('curate:skip', `Skip merge ${cand.aSlug}+${cand.bSlug}: confirm failed — ${(err as Error).message}`, { ...cand });
      continue;
    }
    if (!confirm.proceed) {
      skipped += 1;
      emit('curate:skip', `Skip merge ${cand.aSlug}+${cand.bSlug}: ${confirm.reason}`, { ...cand });
      continue;
    }
    const targetSlug = confirm.targetSlug === cand.bSlug ? cand.bSlug : cand.aSlug;
    const sourceSlug = targetSlug === cand.aSlug ? cand.bSlug : cand.aSlug;
    emit('curate:merge', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });
    const res = await executePageMerge(job.id, subject, { targetSlug, sourceSlug });
    merges += 1;
    referencesRepointed += res.referencesRepointed;
  }

  // 5. split 候选：逐条重校验 + confirm + 执行
  for (const cand of kept.splits) {
    const doc = readPageInSubject(subject.slug, cand.slug);
    if (!doc || PROTECTED_SYSTEM_PAGES.has(cand.slug)) {
      skipped += 1;
      emit('curate:skip', `Skip split ${cand.slug} (stale/invalid).`, { ...cand });
      continue;
    }
    // FIX 2：confirm LLM 瞬时错误不中止整个 pass，跳过此候选继续
    let confirm: CurateSplitConfirm;
    try {
      confirm = await generateStructuredOutput(
        'curate',
        CurateSplitConfirmSchema,
        CURATE_SPLIT_CONFIRM_SYSTEM_PROMPT,
        buildCurateSplitConfirmUserPrompt({ slug: cand.slug, title: doc.frontmatter.title, body: doc.body }, promptCtx),
      );
    } catch (err) {
      skipped += 1;
      emit('curate:skip', `Skip split ${cand.slug}: confirm failed — ${(err as Error).message}`, { ...cand });
      continue;
    }
    if (!confirm.proceed) {
      skipped += 1;
      emit('curate:skip', `Skip split ${cand.slug}: ${confirm.reason}`, { ...cand });
      continue;
    }
    emit('curate:split', `Splitting "${cand.slug}"…`, { sourceSlug: cand.slug });
    try {
      const res = await executePageSplit(job.id, subject, { sourceSlug: cand.slug, hint: confirm.hint });
      splits += 1;
      referencesRepointed += res.referencesRepointed;
    } catch (err) {
      // split 要求 ≥2 页；LLM 拆不出时不致命，跳过。
      skipped += 1;
      emit('curate:skip', `Split "${cand.slug}" failed: ${(err as Error).message}`, { ...cand });
    }
  }

  if (merges + splits > 0) enqueueEmbedIndex(subject.id);

  emit(
    'curate:complete',
    `Curation done: ${merges} merge(s), ${splits} split(s), ${referencesRepointed} reference(s) repointed, ${skipped} skipped.`,
    { merges, splits, referencesRepointed, skipped },
  );
  return { merges, splits, referencesRepointed, skipped };
}

registerHandler('curate', runCurateJob);
