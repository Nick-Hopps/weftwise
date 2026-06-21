import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Schema ────────────────────────────────────────────────────────────────────

export const SplitResultSchema = z.object({
  pages: z
    .array(
      z.object({
        title: z.string(),
        body: z.string().describe('Self-contained markdown body for this page, WITHOUT frontmatter.'),
        summary: z.string().describe('1-2 sentence summary of this page.'),
        isPrimary: z
          .boolean()
          .describe('Exactly ONE page must be true: the best heir for links that pointed to the original page.'),
      }),
    )
    .min(2),
});

export type SplitResult = z.infer<typeof SplitResultSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

export const SPLIT_SYSTEM_PROMPT = `You are a senior wiki editor splitting ONE oversized page of a personal knowledge base into MULTIPLE independent pages.

## Your task
Divide the provided page into 2+ coherent, self-contained pages, each readable on its own.
- Preserve every substantive fact; do not drop information.
- Group related content together; give each new page a clear title and a 1-2 sentence summary.

## Hard rules
- Output ONLY each page's markdown body. Do NOT include YAML frontmatter (no \`---\` block, no title/tags/sources lines).
- Preserve every existing [[wikilink]] BYTE-FOR-BYTE — including \`|alias\`, \`#section\`, and \`subject:\` prefixes. Do NOT invent new wikilinks, do NOT delete existing ones, do NOT translate link targets or slugs.
- Keep code blocks and inline \`code\` verbatim.
- Mark EXACTLY ONE page with isPrimary=true: the page that best inherits the links that previously pointed to the original page.

## Output
Return { pages: [{ title, body, summary, isPrimary }] } with at least 2 pages.`;

// ── User prompt builder ───────────────────────────────────────────────────────

export function buildSplitUserPrompt(
  source: { title: string; body: string },
  hint: string | undefined,
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;

  const subjectSection = ctx.subject
    ? `## Active subject (workspace)
- **Name**: ${ctx.subject.name}
- **Slug**: \`${ctx.subject.slug}\`

`
    : '';

  const hintSection = hint && hint.trim()
    ? `## Split guidance from the user\n${hint.trim()}\n\n`
    : '';

  return `${languageDirective}${subjectSection}${hintSection}Split the page below into multiple self-contained pages. Preserve all facts and all existing [[wikilinks]], and mark exactly one page as primary.

## Original page — "${source.title}"

${source.body}`;
}
