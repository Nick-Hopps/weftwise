import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Triage（只读元数据，收窄候选） ──────────────────────────────────────────────

export const CurateTriageSchema = z.object({
  merges: z
    .array(
      z.object({
        aSlug: z.string().describe('Slug of one page in the candidate pair.'),
        bSlug: z.string().describe('Slug of the other page in the candidate pair.'),
        reason: z.string().describe('Why these two pages are redundant / heavily overlapping.'),
      }),
    )
    .default([]),
  splits: z
    .array(
      z.object({
        slug: z.string().describe('Slug of a page that is too large AND covers multiple distinct topics.'),
        reason: z.string().describe('Why this page should be split.'),
      }),
    )
    .default([]),
});

export type CurateTriage = z.infer<typeof CurateTriageSchema>;

export const CURATE_TRIAGE_SYSTEM_PROMPT = `You are a conservative wiki curator triaging a personal knowledge base for structural maintenance.

You are given ONLY page metadata (slug, title, summary, tags, body size). Propose candidate structural operations:
- merges: two pages that are clearly REDUNDANT or HEAVILY OVERLAPPING (same topic written twice, a stub duplicating a fuller page).
- splits: a single page that is clearly TOO LARGE *and* covers MULTIPLE DISTINCT TOPICS that deserve their own pages.

## Be conservative — this is the most important rule
- When in doubt, propose NOTHING. A clean wiki with a few large pages is far better than an over-fragmented or wrongly-merged one.
- Do NOT propose a merge just because two pages are related or cross-link — only when they substantially duplicate each other.
- Do NOT propose a split just because a page is long — only when it bundles unrelated topics.
- Never reference slugs that are not in the provided list. Never propose merging a page with itself.

## Output
Return { merges, splits }. Either array may be empty. Each item carries a short reason.`;

export function buildCurateTriageUserPrompt(
  pages: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[],
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  const subjectSection = ctx.subject
    ? `## Active subject (workspace)\n- **Name**: ${ctx.subject.name}\n- **Slug**: \`${ctx.subject.slug}\`\n\n`
    : '';

  const list = pages
    .map(
      (p) =>
        `- slug: \`${p.slug}\` | title: "${p.title}" | size: ${p.bodyChars} chars | tags: ${p.tags.join(', ') || '(none)'}\n  summary: ${p.summary || '(none)'}`,
    )
    .join('\n');

  return `${languageDirective}${subjectSection}Below is the metadata of every page in scope. Identify conservative merge / split candidates.

## Pages (${pages.length})
${list}

Return candidate merges and splits. When unsure, return empty arrays.`;
}

// ── Merge confirm（载入两页正文，确认 go/no-go + 选存活页） ─────────────────────

export const CurateMergeConfirmSchema = z.object({
  proceed: z.boolean().describe('True only if the two pages should genuinely be merged.'),
  targetSlug: z
    .string()
    .optional()
    .describe('When proceeding, the slug of the page that should SURVIVE (the more complete / canonical one). Must be one of the two input slugs.'),
  reason: z.string().describe('Short justification of the decision.'),
});

export type CurateMergeConfirm = z.infer<typeof CurateMergeConfirmSchema>;

export const CURATE_MERGE_CONFIRM_SYSTEM_PROMPT = `You are a conservative wiki curator deciding whether two specific pages should be merged into one.

You now see the FULL body of both pages. Confirm a merge ONLY if they substantially cover the same topic and one coherent page would serve the reader better.
- If they are merely related, complementary, or cross-referenced, do NOT merge (proceed=false).
- When proceeding, choose targetSlug = the page that should survive (usually the more complete / canonical one); the other is absorbed and deleted.
- Default to proceed=false when uncertain.`;

export function buildCurateMergeConfirmUserPrompt(
  a: { slug: string; title: string; body: string },
  b: { slug: string; title: string; body: string },
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  return `${languageDirective}Decide whether to merge these two pages. If yes, pick which one survives (targetSlug must be "${a.slug}" or "${b.slug}").

## Page 1 — slug \`${a.slug}\` — "${a.title}"

${a.body}

---

## Page 2 — slug \`${b.slug}\` — "${b.title}"

${b.body}

---

Return { proceed, targetSlug, reason }.`;
}

// ── Split confirm（载入页面正文，确认 go/no-go + 可选 hint） ────────────────────

export const CurateSplitConfirmSchema = z.object({
  proceed: z.boolean().describe('True only if the page should genuinely be split.'),
  hint: z
    .string()
    .optional()
    .describe('When proceeding, an optional hint describing how to divide the page (which topics become which pages).'),
  reason: z.string().describe('Short justification of the decision.'),
});

export type CurateSplitConfirm = z.infer<typeof CurateSplitConfirmSchema>;

export const CURATE_SPLIT_CONFIRM_SYSTEM_PROMPT = `You are a conservative wiki curator deciding whether one specific page should be split into multiple pages.

You now see the FULL body of the page. Confirm a split ONLY if it clearly bundles MULTIPLE DISTINCT TOPICS that each deserve their own page.
- A long but cohesive page about a single topic should NOT be split (proceed=false).
- When proceeding, you may give a short hint describing the intended division.
- Default to proceed=false when uncertain.`;

export function buildCurateSplitConfirmUserPrompt(
  page: { slug: string; title: string; body: string },
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  return `${languageDirective}Decide whether to split this page into multiple independent pages.

## Page — slug \`${page.slug}\` — "${page.title}"

${page.body}

---

Return { proceed, hint, reason }.`;
}
