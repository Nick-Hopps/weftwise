/**
 * Fix service — 任务类型 'fix'：一键修复 Health lint findings。
 * 工作清单 = 新鲜重扫确定性（missing-frontmatter / broken-link）∪ 最近 lint 快照语义
 *   （missing-crossref / contradiction）。
 * 阶段1 确定性：所有 frontmatter 修复合并为一个 Saga commit。
 * 阶段2 LLM：按 pageSlug 分组，逐页 generateStructuredOutput('fix')，自我门控 + validateChangeset
 *   拦截新坏链，每页一个 commit。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('fix', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as queue from '../jobs/queue';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { enqueueEmbedIndex } from './embedding-service';
import { runDeterministicChecksForSubject } from './lint-deterministic';
import { selectLatestFindings } from './lint-latest';
import { fixMissingFrontmatter, partitionFindings, buildFixWorklist } from './fix-deterministic';
import { readPageInSubject } from '../wiki/wiki-store';
import { buildWikiPath } from '../wiki/page-identity';
import { serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import { createChangeset, validateChangeset, applyChangeset } from '../wiki/wiki-transaction';
import { generateStructuredOutput } from '../llm/provider-registry';
import { FixPageSchema, FIX_SYSTEM_PROMPT, buildFixPageUserPrompt, type FixPageResult } from '../llm/prompts/fix-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { ChangesetEntry, Job, LintFinding } from '@/lib/contracts';

interface FixParams {
  subjectId?: string;
}

async function runFixJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as FixParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('fix job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  // 1. 工作清单：确定性新鲜重扫 + 快照语义
  const freshDeterministic = runDeterministicChecksForSubject(subject).filter(
    (f) => f.type === 'missing-frontmatter' || f.type === 'broken-link',
  );
  const snapshotSemantic = selectLatestFindings(
    queue.list({ type: 'lint', status: 'completed', subjectId: subject.id }),
  ).findings.filter((f) => f.type === 'missing-crossref' || f.type === 'contradiction');

  const worklist = buildFixWorklist(freshDeterministic, snapshotSemantic);
  const { frontmatter, llm } = partitionFindings(worklist);

  emit('fix:start', `Fixing ${frontmatter.length + llm.length} issue(s) in "${subject.slug}"…`, {
    deterministic: frontmatter.length,
    semantic: llm.length,
  });

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  const byType: Record<string, number> = {};
  const bump = (type: string, n = 1) => {
    byType[type] = (byType[type] ?? 0) + n;
  };

  // 2. 阶段1 确定性 frontmatter 修复 — 合并为一个 commit
  if (frontmatter.length > 0) {
    const now = new Date().toISOString();
    const entries: ChangesetEntry[] = [];
    for (const finding of frontmatter) {
      try {
        const doc = readPageInSubject(subject.slug, finding.pageSlug);
        if (!doc) {
          skipped += 1;
          continue;
        }
        const content = fixMissingFrontmatter(finding.pageSlug, doc, now);
        entries.push({ action: 'update', path: buildWikiPath(subject.slug, finding.pageSlug), content });
      } catch {
        skipped += 1;
      }
    }
    if (entries.length > 0) {
      const changeset = createChangeset(job.id, subject, entries);
      const validation = validateChangeset(changeset);
      if (validation.valid) {
        await applyChangeset(changeset);
        fixed += entries.length;
        bump('missing-frontmatter', entries.length);
        emit('fix:deterministic', `Fixed ${entries.length} frontmatter issue(s).`, { fixed: entries.length });
      } else {
        failed += entries.length;
        emit('fix:warn', `Frontmatter fixes failed validation: ${validation.errors.join('; ')}`, {
          errors: validation.errors,
        });
      }
    }
  }

  // 3. 阶段2 LLM 逐页修复 — 按 pageSlug 分组，每页一个 commit
  const byPage = new Map<string, LintFinding[]>();
  for (const finding of llm) {
    const arr = byPage.get(finding.pageSlug) ?? [];
    arr.push(finding);
    byPage.set(finding.pageSlug, arr);
  }

  const roster = pagesRepo.getAllPages(subject.id).map((p) => ({ slug: p.slug, title: p.title }));
  const promptCtx = {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };

  for (const [slug, findingsOnPage] of byPage) {
    const doc = readPageInSubject(subject.slug, slug);
    if (!doc) {
      skipped += findingsOnPage.length;
      emit('fix:skip', `Skip "${slug}": page not found.`, { slug });
      continue;
    }

    let result: FixPageResult;
    try {
      result = await generateStructuredOutput(
        'fix',
        FixPageSchema,
        FIX_SYSTEM_PROMPT,
        buildFixPageUserPrompt(
          { slug, title: doc.frontmatter.title, body: doc.body },
          findingsOnPage.map((f) => ({ type: f.type, description: f.description, suggestedFix: f.suggestedFix })),
          roster,
          promptCtx,
        ),
      );
    } catch (err) {
      skipped += findingsOnPage.length;
      emit('fix:skip', `Skip "${slug}": LLM error — ${(err as Error).message}`, { slug });
      continue;
    }

    if (!result.proceed) {
      skipped += findingsOnPage.length;
      emit('fix:skip', `Skip "${slug}": ${result.reason}`, { slug, reason: result.reason });
      continue;
    }

    const now = new Date().toISOString();
    const frontmatterData = {
      ...doc.frontmatter,
      ...(result.summary ? { summary: result.summary } : {}),
    };
    const content = stampSystemFrontmatter(serializeFrontmatter(frontmatterData, result.body), {
      now,
      existingCreated: doc.frontmatter.created,
    });

    const changeset = createChangeset(job.id, subject, [
      { action: 'update', path: buildWikiPath(subject.slug, slug), content },
    ]);
    const validation = validateChangeset(changeset);
    if (!validation.valid) {
      failed += findingsOnPage.length;
      emit('fix:warn', `Skip "${slug}": fix introduced invalid links — ${validation.errors.join('; ')}`, {
        slug,
        errors: validation.errors,
      });
      continue;
    }

    await applyChangeset(changeset);
    fixed += findingsOnPage.length;
    for (const f of findingsOnPage) bump(f.type);
    emit('fix:page', `Repaired "${slug}" (${findingsOnPage.map((f) => f.type).join(', ')}).`, {
      slug,
      types: findingsOnPage.map((f) => f.type),
    });
  }

  if (fixed > 0) enqueueEmbedIndex(subject.id);

  emit('fix:complete', `Fix complete: ${fixed} fixed, ${skipped} skipped, ${failed} failed.`, {
    fixed,
    skipped,
    failed,
    byType,
  });
  return { fixed, skipped, failed, byType };
}

registerHandler('fix', runFixJob);
