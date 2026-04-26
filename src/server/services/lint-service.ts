/**
 * Lint service — two-phase wiki quality audit.
 *
 * Phase 1 (deterministic): broken wikilinks, orphan pages, missing frontmatter,
 *                           stale sources. No LLM required.
 * Phase 2 (semantic):      contradictions, missing cross-references, coverage
 *                           gaps detected by the LLM.
 *
 * Lint runs per-subject. A job with `subjectId === null` falls back to scanning
 * every subject; per-subject jobs (the common case) only audit pages within
 * that subject.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import { registerHandler } from '../jobs/worker';
import * as pagesRepo from '../db/repos/pages-repo';
import * as sourcesRepo from '../db/repos/sources-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { scanWikiPages } from '../wiki/wiki-store';
import { vaultPath } from '../config/env';
import { parseFrontmatter, validateFrontmatter } from '../wiki/frontmatter';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  LintResultSchema,
  LINT_SYSTEM_PROMPT,
  buildLintUserPrompt,
} from '../llm/prompts/lint-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { PromptContext } from '../llm/prompts/prompt-context';
import type { LintFinding, Job, Subject } from '@/lib/contracts';

const ORPHAN_EXCLUDE_SLUGS = new Set(['index', 'log']);
const MAX_SEMANTIC_PROMPT_CHARS = 120_000;

// ── Phase 1: Deterministic checks per subject ────────────────────────────────

function runDeterministicChecksForSubject(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  findings.push(...checkBrokenLinks(subject));
  findings.push(...checkOrphanPages(subject));
  findings.push(...checkMissingFrontmatter(subject));
  findings.push(...checkStaleSources(subject));
  return findings;
}

function checkBrokenLinks(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  const allLinks = pagesRepo.getAllLinks(subject.id);
  const allPages = pagesRepo.getAllPages(subject.id);
  const slugSet = new Set(allPages.map((p) => p.slug));

  for (const link of allLinks) {
    // Same-subject link to a missing page
    if (link.targetSubjectId === subject.id && !slugSet.has(link.targetSlug)) {
      findings.push({
        type: 'broken-link',
        severity: 'warning',
        pageSlug: link.sourceSlug,
        description: `Broken wikilink: [[${link.targetSlug}]] referenced from "${link.sourceSlug}" does not exist in subject "${subject.slug}".`,
        suggestedFix: `Create a page with slug "${link.targetSlug}" or update the link to point to an existing page.`,
      });
      continue;
    }

    // Cross-subject link: verify the target page exists in the target subject
    if (link.targetSubjectId !== subject.id) {
      const exists = pagesRepo.getPageBySlug(link.targetSubjectId, link.targetSlug);
      if (!exists) {
        const targetSubject = subjectsRepo.getById(link.targetSubjectId);
        const targetSubjectSlug = targetSubject?.slug ?? link.targetSubjectId;
        findings.push({
          type: 'broken-link',
          severity: 'warning',
          pageSlug: link.sourceSlug,
          description: `Broken cross-subject wikilink: [[${targetSubjectSlug}:${link.targetSlug}]] referenced from "${link.sourceSlug}" does not exist.`,
          suggestedFix: `Create the target page in subject "${targetSubjectSlug}", or remove the cross-subject reference.`,
        });
      }
    }
  }

  return findings;
}

function checkOrphanPages(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  const allPages = pagesRepo.getAllPages(subject.id);
  const allLinks = pagesRepo.getAllLinks(); // cross-subject backlinks count as inbound
  const inboundSlugs = new Set<string>();
  for (const link of allLinks) {
    if (link.targetSubjectId === subject.id) {
      inboundSlugs.add(link.targetSlug);
    }
  }

  for (const page of allPages) {
    if (ORPHAN_EXCLUDE_SLUGS.has(page.slug)) continue;
    if ((page.tags ?? []).includes('meta')) continue;
    if (!inboundSlugs.has(page.slug)) {
      findings.push({
        type: 'orphan',
        severity: 'info',
        pageSlug: page.slug,
        description: `Orphan page: "${page.slug}" in subject "${subject.slug}" has no inbound links.`,
        suggestedFix: `Link to this page from at least one related page, or from the subject's index page.`,
      });
    }
  }

  return findings;
}

function checkMissingFrontmatter(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  const wikiFiles = scanWikiPages(subject.slug);

  for (const file of wikiFiles) {
    try {
      const { data } = parseFrontmatter(file.content);
      const validation = validateFrontmatter(data as unknown as Record<string, unknown>);
      if (!validation.valid) {
        findings.push({
          type: 'missing-frontmatter',
          severity: 'warning',
          pageSlug: file.slug,
          description: `Invalid frontmatter in "${file.slug}" (subject: ${subject.slug}): ${validation.errors.join('; ')}.`,
          suggestedFix: `Add or fix the required YAML frontmatter fields: title, created, updated, tags, sources.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        type: 'missing-frontmatter',
        severity: 'warning',
        pageSlug: file.slug,
        description: `Failed to parse frontmatter in "${file.slug}" (subject: ${subject.slug}): ${msg}.`,
        suggestedFix: `Ensure the page has a valid YAML frontmatter block delimited by "---".`,
      });
    }
  }

  return findings;
}

function rawSourcePathsToCheck(subjectSlug: string, filename: string): string[] {
  return [
    vaultPath('raw', subjectSlug, filename),
    vaultPath('raw', filename), // legacy flat layout
  ];
}

function checkStaleSources(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  const allPages = pagesRepo.getAllPages(subject.id);

  for (const page of allPages) {
    const sources = sourcesRepo.getSourcesForPage(subject.id, page.slug);
    for (const source of sources) {
      const candidates = rawSourcePathsToCheck(subject.slug, source.filename);
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) {
        findings.push({
          type: 'stale-source',
          severity: 'info',
          pageSlug: page.slug,
          description: `Source file "${source.filename}" linked to "${page.slug}" (subject: ${subject.slug}) no longer exists on disk.`,
          suggestedFix: `Re-ingest the source or remove the association from the database.`,
        });
        continue;
      }

      const diskContent = fs.readFileSync(found);
      const diskHash = createHash('sha256')
        .update(diskContent)
        .digest('hex')
        .slice(0, 16);

      if (diskHash !== source.contentHash) {
        findings.push({
          type: 'stale-source',
          severity: 'info',
          pageSlug: page.slug,
          description: `Source file "${source.filename}" for page "${page.slug}" (subject: ${subject.slug}) has changed on disk (stored hash: ${source.contentHash}, current hash: ${diskHash}).`,
          suggestedFix: `Re-ingest the source file to update the wiki page content.`,
        });
      }
    }
  }

  return findings;
}

// ── Phase 2: Semantic checks per subject ─────────────────────────────────────

async function runSemanticChecksForSubject(subject: Subject): Promise<LintFinding[]> {
  const wikiFiles = scanWikiPages(subject.slug);
  if (wikiFiles.length === 0) return [];

  const allPages = pagesRepo.getAllPages(subject.id);
  const titleBySlug = new Map(allPages.map((p) => [p.slug, p.title]));

  const pagesForPrompt = wikiFiles.map((f) => ({
    slug: f.slug,
    title: titleBySlug.get(f.slug) ?? f.slug,
    content: f.content,
  }));

  // Split pages into batches that fit within the LLM context limit
  const batches: (typeof pagesForPrompt)[] = [];
  let currentBatch: typeof pagesForPrompt = [];
  let currentChars = 0;

  for (const p of pagesForPrompt) {
    const pageChars = p.content.length;
    if (currentBatch.length > 0 && currentChars + pageChars > MAX_SEMANTIC_PROMPT_CHARS) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(p);
    currentChars += pageChars;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  const allFindings: LintFinding[] = [];
  const subjectCtx = {
    slug: subject.slug,
    name: subject.name,
    description: subject.description,
  };

  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: subjectCtx,
  };

  for (const batch of batches) {
    const userPrompt = buildLintUserPrompt(batch, promptCtx);
    const result = await generateStructuredOutput(
      'lint',
      LintResultSchema,
      LINT_SYSTEM_PROMPT,
      userPrompt,
    );

    allFindings.push(
      ...result.findings.map((f): LintFinding => ({
        type: f.type,
        severity: f.severity,
        pageSlug: f.pageSlug,
        description: f.description,
        suggestedFix: f.suggestedFix,
      })),
    );
  }

  return allFindings;
}

// ── Main job handler ──────────────────────────────────────────────────────────

interface LintParams {
  subjectId?: string;
}

async function runLintJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as LintParams;
  const targetSubjectId = params.subjectId ?? job.subjectId ?? null;

  const targets: Subject[] = targetSubjectId
    ? (() => {
        const found = subjectsRepo.getById(targetSubjectId);
        if (!found) throw new Error(`Subject ${targetSubjectId} not found`);
        return [found];
      })()
    : subjectsRepo.listSubjects();

  emit(
    'lint:scope',
    targetSubjectId
      ? `Linting subject: ${targets[0].slug}`
      : `Linting all ${targets.length} subject(s)`,
    { subjectIds: targets.map((s) => s.id) }
  );

  const allFindings: (LintFinding & { subjectId: string; subjectSlug: string })[] = [];

  for (const subject of targets) {
    emit('lint:deterministic:start', `Subject "${subject.slug}": running deterministic checks...`);
    const deterministicFindings = runDeterministicChecksForSubject(subject);
    allFindings.push(
      ...deterministicFindings.map((f) => ({ ...f, subjectId: subject.id, subjectSlug: subject.slug })),
    );
    emit(
      'lint:deterministic:done',
      `Subject "${subject.slug}": ${deterministicFindings.length} deterministic finding(s)`,
      { findings: deterministicFindings, subject: subject.slug }
    );

    emit('lint:semantic:start', `Subject "${subject.slug}": running LLM semantic analysis...`);
    try {
      const semanticFindings = await runSemanticChecksForSubject(subject);
      allFindings.push(
        ...semanticFindings.map((f) => ({ ...f, subjectId: subject.id, subjectSlug: subject.slug })),
      );
      emit(
        'lint:semantic:done',
        `Subject "${subject.slug}": ${semanticFindings.length} semantic finding(s)`,
        { findings: semanticFindings, subject: subject.slug }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      emit('lint:semantic:error', `Subject "${subject.slug}": semantic analysis failed: ${msg}`);
    }
  }

  emit(
    'lint:complete',
    `Lint complete: ${allFindings.length} total finding(s)`,
    {
      totalFindings: allFindings.length,
      bySeverity: {
        critical: allFindings.filter((f) => f.severity === 'critical').length,
        warning: allFindings.filter((f) => f.severity === 'warning').length,
        info: allFindings.filter((f) => f.severity === 'info').length,
      },
    },
  );

  return { findings: allFindings };
}

registerHandler('lint', runLintJob);
