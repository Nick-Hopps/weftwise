/**
 * Lint Phase 2 — semantic 检查（LLM）。
 *
 * 覆盖：contradictions / missing cross-references / coverage gaps。
 * 页面按字符预算分批送入 LLM（generateObject + zod schema）。
 */

import * as pagesRepo from '../db/repos/pages-repo';
import { scanWikiPages } from '../wiki/wiki-store';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  LintResultSchema,
  LINT_SYSTEM_PROMPT,
  buildLintUserPrompt,
} from '../llm/prompts/lint-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { PromptContext } from '../llm/prompts/prompt-context';
import type { LintFinding, Subject } from '@/lib/contracts';
import { validateSemanticFindings } from './lint-semantic-validation';

const MAX_SEMANTIC_PROMPT_CHARS = 120_000;

export async function runSemanticChecksForSubject(subject: Subject): Promise<LintFinding[]> {
  const wikiFiles = scanWikiPages(subject.slug);
  if (wikiFiles.length === 0) return [];

  const allPages = pagesRepo.getAllPages(subject.id);
  const titleBySlug = new Map(allPages.map((p) => [p.slug, p.title]));
  const knownPageNames = pagesRepo.getTitleToSlugMap(subject.id);

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
      { temperature: 0 },
      { schemaRetries: 1, usageSubjectId: subject.id },
    );

    allFindings.push(
      ...validateSemanticFindings(
        result.findings,
        pagesForPrompt,
        subject.slug,
        knownPageNames,
      ),
    );
  }

  return allFindings;
}
