/**
 * Lint service — two-phase wiki quality audit.
 *
 * Phase 1 (deterministic): broken wikilinks, orphan pages, missing frontmatter,
 *                           stale sources. No LLM required.
 * Phase 2 (semantic):      contradictions, missing cross-references, coverage
 *                           gaps detected by the LLM.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { registerHandler } from '../jobs/worker';
import * as pagesRepo from '../db/repos/pages-repo';
import * as sourcesRepo from '../db/repos/sources-repo';
import { scanWikiPages } from '../wiki/wiki-store';
import { parseFrontmatter, validateFrontmatter } from '../wiki/frontmatter';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  LintResultSchema,
  LINT_SYSTEM_PROMPT,
  buildLintUserPrompt,
} from '../llm/prompts/lint-prompt';
import { vaultPath } from '../config/env';
import type { LintFinding, Job } from '@/lib/contracts';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Pages that are excluded from orphan detection (they act as root/index nodes). */
const ORPHAN_EXCLUDE_SLUGS = new Set(['index', 'log']);

// ── Phase 1: Deterministic checks ────────────────────────────────────────────

/**
 * Run all deterministic lint checks synchronously.
 * Returns a (possibly empty) list of findings.
 */
function runDeterministicChecks(): LintFinding[] {
  const findings: LintFinding[] = [];

  findings.push(...checkBrokenLinks());
  findings.push(...checkOrphanPages());
  findings.push(...checkMissingFrontmatter());
  findings.push(...checkStaleSources());

  return findings;
}

/**
 * Check for wikilinks whose target page does not exist in the DB.
 */
function checkBrokenLinks(): LintFinding[] {
  const findings: LintFinding[] = [];
  const allLinks = pagesRepo.getAllLinks();
  const allPages = pagesRepo.getAllPages();
  const slugSet = new Set(allPages.map((p) => p.slug));

  for (const link of allLinks) {
    if (!slugSet.has(link.targetSlug)) {
      findings.push({
        type: 'broken-link',
        severity: 'warning',
        pageSlug: link.sourceSlug,
        description: `Broken wikilink: [[${link.targetSlug}]] referenced from "${link.sourceSlug}" does not exist.`,
        suggestedFix: `Create a page with slug "${link.targetSlug}" or update the link to point to an existing page.`,
      });
    }
  }

  return findings;
}

/**
 * Check for pages that have no inbound links (orphans).
 * Excludes index and log pages as they are structural root nodes.
 */
function checkOrphanPages(): LintFinding[] {
  const findings: LintFinding[] = [];
  const allPages = pagesRepo.getAllPages();
  const allLinks = pagesRepo.getAllLinks();

  const linkedSlugs = new Set(allLinks.map((l) => l.targetSlug));

  for (const page of allPages) {
    if (ORPHAN_EXCLUDE_SLUGS.has(page.slug)) continue;
    if (!linkedSlugs.has(page.slug)) {
      findings.push({
        type: 'orphan',
        severity: 'info',
        pageSlug: page.slug,
        description: `Orphan page: "${page.slug}" has no inbound links from any other wiki page.`,
        suggestedFix: `Link to this page from at least one related page, or from the index page.`,
      });
    }
  }

  return findings;
}

/**
 * Scan all wiki files and validate their YAML frontmatter.
 */
function checkMissingFrontmatter(): LintFinding[] {
  const findings: LintFinding[] = [];
  const wikiFiles = scanWikiPages();

  for (const file of wikiFiles) {
    try {
      const { data } = parseFrontmatter(file.content);
      const validation = validateFrontmatter(data as unknown as Record<string, unknown>);
      if (!validation.valid) {
        findings.push({
          type: 'missing-frontmatter',
          severity: 'warning',
          pageSlug: file.slug,
          description: `Invalid frontmatter in "${file.slug}": ${validation.errors.join('; ')}.`,
          suggestedFix: `Add or fix the required YAML frontmatter fields: title, created, updated, tags, sources.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        type: 'missing-frontmatter',
        severity: 'warning',
        pageSlug: file.slug,
        description: `Failed to parse frontmatter in "${file.slug}": ${msg}.`,
        suggestedFix: `Ensure the page has a valid YAML frontmatter block delimited by "---".`,
      });
    }
  }

  return findings;
}

/**
 * Check for sources whose on-disk content has changed since the DB hash was recorded.
 */
function checkStaleSources(): LintFinding[] {
  const findings: LintFinding[] = [];
  const allPages = pagesRepo.getAllPages();

  for (const page of allPages) {
    const sources = sourcesRepo.getSourcesForPage(page.slug);
    for (const source of sources) {
      const rawFilePath = path.join(vaultPath('raw'), path.basename(source.filename));
      if (!fs.existsSync(rawFilePath)) {
        // Source file missing entirely
        findings.push({
          type: 'stale-source',
          severity: 'info',
          pageSlug: page.slug,
          description: `Source file "${source.filename}" linked to "${page.slug}" no longer exists on disk.`,
          suggestedFix: `Re-ingest the source or remove the association from the database.`,
        });
        continue;
      }

      const diskContent = fs.readFileSync(rawFilePath);
      const diskHash = createHash('sha256')
        .update(diskContent)
        .digest('hex')
        .slice(0, 16);

      if (diskHash !== source.contentHash) {
        findings.push({
          type: 'stale-source',
          severity: 'info',
          pageSlug: page.slug,
          description: `Source file "${source.filename}" for page "${page.slug}" has changed on disk (stored hash: ${source.contentHash}, current hash: ${diskHash}).`,
          suggestedFix: `Re-ingest the source file to update the wiki page content.`,
        });
      }
    }
  }

  return findings;
}

// ── Phase 2: Semantic checks via LLM ─────────────────────────────────────────

/**
 * Run semantic lint checks using the configured LLM.
 * Returns findings for contradictions, missing cross-references, and coverage gaps.
 */
// Maximum total characters of page content to send to the LLM in a single
// semantic check batch, to avoid exceeding model context limits.
const MAX_SEMANTIC_PROMPT_CHARS = 120_000;

async function runSemanticChecks(): Promise<LintFinding[]> {
  const wikiFiles = scanWikiPages();

  if (wikiFiles.length === 0) {
    return [];
  }

  const pagesForPrompt = wikiFiles.map((f) => ({
    slug: f.slug,
    title: f.slug, // Use slug as title fallback; frontmatter title resolved below
    content: f.content,
  }));

  // Enrich with DB titles where available
  const allPages = pagesRepo.getAllPages();
  const titleBySlug = new Map(allPages.map((p) => [p.slug, p.title]));
  for (const p of pagesForPrompt) {
    const dbTitle = titleBySlug.get(p.slug);
    if (dbTitle) p.title = dbTitle;
  }

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

  for (const batch of batches) {
    const userPrompt = buildLintUserPrompt(batch);
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

async function runLintJob(
  _job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const allFindings: LintFinding[] = [];

  // Phase 1 — deterministic checks
  emit('lint:deterministic:start', 'Running deterministic checks...');
  const deterministicFindings = runDeterministicChecks();
  allFindings.push(...deterministicFindings);
  emit(
    'lint:deterministic:done',
    `Found ${deterministicFindings.length} issue(s)`,
    { findings: deterministicFindings },
  );

  // Phase 2 — semantic checks
  emit('lint:semantic:start', 'Running LLM semantic analysis...');
  try {
    const semanticFindings = await runSemanticChecks();
    allFindings.push(...semanticFindings);
    emit(
      'lint:semantic:done',
      `Found ${semanticFindings.length} issue(s)`,
      { findings: semanticFindings },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emit('lint:semantic:error', `Semantic analysis failed: ${msg}`);
    // Phase 1 results remain valid; do not rethrow
  }

  // Summary event
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

// Register this handler when the module is imported
registerHandler('lint', runLintJob);
