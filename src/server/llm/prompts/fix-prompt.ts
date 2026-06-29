import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Schema ────────────────────────────────────────────────────────────────────

export const FixPageSchema = z.object({
  proceed: z
    .boolean()
    .describe('true if you can confidently repair the listed issues on this page; false to leave it untouched'),
  reason: z
    .string()
    .describe('If proceed=false, explain why you declined. If proceed=true, a one-line summary of what you changed.'),
  body: z
    .string()
    .describe(
      'The full corrected page body in markdown (NO frontmatter). Faithful repair: change ONLY what the findings require; preserve all other prose, headings, callouts and wikilinks verbatim.',
    ),
  summary: z
    .string()
    .optional()
    .describe('Optional updated one-line page summary — include only if your edits materially change the page focus.'),
});

export type FixPageResult = z.infer<typeof FixPageSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

export const FIX_SYSTEM_PROMPT = `You are a meticulous wiki editor repairing quality issues on a single page of a personal knowledge base.

## Your job
You are given ONE page and a list of issues detected on it. Repair ONLY those issues and return the corrected page body.

## Issue types you may see
- **broken-link**: the page contains a [[wikilink]] whose target page does not exist.
  - If a roster page is an obvious match (typo / casing / pluralisation), relink to it using the roster page's exact title: [[Exact Title]].
  - If there is no good target, UNWRAP the link: remove the [[ ]] but keep the visible text as plain prose.
  - Never invent a target that is not in the roster.
- **missing-crossref**: the page mentions a concept that has its own roster page but is not linked.
  - Wrap the FIRST natural mention in a wikilink using the roster page's exact title: [[Exact Title]]. Do not duplicate links.
- **contradiction**: the page states something that conflicts with another page.
  - Only edit if you can confidently make the page internally consistent and faithful to the source material.
  - If resolving requires knowing which side is correct and you cannot tell, set proceed=false and explain. Do NOT guess.

## Hard rules
- Faithful editing: do not rewrite, summarise, reorder, or "improve" prose beyond what the issues require.
- Only emit [[wikilinks]] whose target appears in the page roster below. Do not translate slugs, titles, wikilink targets, or code blocks.
- Do not touch frontmatter — return body only. The system owns title/timestamps.
- If you cannot fix the issues without risky changes, set proceed=false with a clear reason.

## Wider context (read-only)
- You may also be shown a **subject-wide health report** (all outstanding issues, grouped by page) and the **current content of related pages**. These are READ-ONLY — they exist only to help you understand cross-page issues. Always return ONLY the corrected body of the page under repair; never edit, or describe edits to, any other page.
- For **contradiction**: when related pages are shown, use them to make THIS page consistent with the rest of the subject and faithful to the source material. If you still cannot tell which side is correct, set proceed=false.`;

// ── User prompt builder ───────────────────────────────────────────────────────

export function buildFixPageUserPrompt(
  page: { slug: string; title: string; body: string },
  findings: { type: string; description: string; suggestedFix: string | null }[],
  roster: { slug: string; title: string }[],
  ctx: PromptContext,
  extra?: {
    subjectReport?: { slug: string; lines: string[] }[];
    relatedPages?: { title: string; slug: string; body: string }[];
  },
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;

  const subjectSection = ctx.subject
    ? `## Active subject (workspace)
- **Name**: ${ctx.subject.name}
- **Slug**: \`${ctx.subject.slug}\`
${ctx.subject.description?.trim() ? `- **Description**: ${ctx.subject.description.trim()}\n` : ''}
`
    : '';

  const issuesSection = findings
    .map(
      (finding, i) =>
        `${i + 1}. **${finding.type}** — ${finding.description}${
          finding.suggestedFix ? `\n   Suggested fix: ${finding.suggestedFix}` : ''
        }`,
    )
    .join('\n');

  const rosterSection =
    roster.length > 0
      ? roster.map((p) => `- [[${p.title}]] (slug: \`${p.slug}\`)`).join('\n')
      : '(no other pages in this subject)';

  // 两个可选只读上下文段：各自以 \n 起止；数据缺省/为空时整段为空串，模板中的
  // `${issuesSection}\n${reportSection}${relatedSection}\n### Page roster` 因而退化为
  // 原始的 `\n\n` 分隔——保证不传 extra 时输出与改动前逐字一致（基线测试守卫）。
  const reportSection =
    extra?.subjectReport && extra.subjectReport.length > 0
      ? `\n## Subject-wide health report (read-only context)\n` +
        `These are ALL outstanding issues across this subject, grouped by page. Use this only to understand the bigger picture (e.g. another page references this one). You may ONLY edit the page under repair below — do NOT attempt to edit other pages.\n\n` +
        extra.subjectReport
          .map((p) => `### \`${p.slug}\`\n${p.lines.map((l) => `- ${l}`).join('\n')}`)
          .join('\n\n') +
        `\n`
      : '';

  const relatedSection =
    extra?.relatedPages && extra.relatedPages.length > 0
      ? `\n## Related pages (read-only — current content of pages your findings reference)\n` +
        `Provided so you can reconcile cross-page issues (especially contradictions). Treat as reference only; do not copy wholesale and do not edit them.\n\n` +
        extra.relatedPages
          .map((p) => `### [[${p.title}]] (slug: \`${p.slug}\`)\n${p.body}`)
          .join('\n\n') +
        `\n`
      : '';

  return `${languageDirective}${subjectSection}## Page under repair: [[${page.title}]] (slug: \`${page.slug}\`)

### Current body
${page.body}

### Issues to repair on this page
${issuesSection}
${reportSection}${relatedSection}
### Page roster (the ONLY valid wikilink targets in this subject)
${rosterSection}

---

Repair the listed issues faithfully and return the corrected body. If you cannot do so confidently, set proceed=false.`;
}
