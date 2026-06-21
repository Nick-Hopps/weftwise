import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Schema ────────────────────────────────────────────────────────────────────

export const MergeResultSchema = z.object({
  mergedBody: z
    .string()
    .describe('The merged markdown body, WITHOUT any frontmatter. Combine both pages into one coherent article.'),
  mergedSummary: z
    .string()
    .describe('A 1-2 sentence summary of the merged page.'),
});

export type MergeResult = z.infer<typeof MergeResultSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

export const MERGE_SYSTEM_PROMPT = `You are a senior wiki editor merging two pages of a personal knowledge base into ONE page.

## Your task
Combine the two provided pages (A = the surviving page, B = the page being absorbed) into a single coherent article.
- Preserve every substantive fact from both pages; do not drop information.
- De-duplicate overlapping content; reconcile and organise into a clear structure with headings.
- Write the result as the body of the surviving page A.

## Hard rules
- Output ONLY the merged markdown body. Do NOT include YAML frontmatter (no \`---\` block, no title/tags/sources lines).
- Preserve every existing [[wikilink]] BYTE-FOR-BYTE — including \`|alias\`, \`#section\`, and \`subject:\` prefixes. Do NOT invent new wikilinks, do NOT delete existing ones, do NOT translate link targets or slugs.
- Keep code blocks and inline \`code\` verbatim.

## Output
Return { mergedBody, mergedSummary }. mergedSummary is a 1-2 sentence overview of the merged page.`;

// ── User prompt builder ───────────────────────────────────────────────────────

export function buildMergeUserPrompt(
  a: { title: string; body: string },
  b: { title: string; body: string },
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;

  const subjectSection = ctx.subject
    ? `## Active subject (workspace)
- **Name**: ${ctx.subject.name}
- **Slug**: \`${ctx.subject.slug}\`
Both pages belong to this subject.

`
    : '';

  return `${languageDirective}${subjectSection}Merge the two pages below into one coherent article. Page A is the surviving page; fold Page B into it.

## Page A (surviving) — "${a.title}"

${a.body}

---

## Page B (absorbed) — "${b.title}"

${b.body}

---

Combine them, de-duplicate, preserve all facts and all existing [[wikilinks]], and return the merged body plus a short summary.`;
}
