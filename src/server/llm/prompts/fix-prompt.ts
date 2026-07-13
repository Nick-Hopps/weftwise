import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Agentic（tool-loop 修复）────────────────────────────────────────────────────

export function buildFixAgenticSystemPrompt(allowGeneralEdits: boolean): string {
  const generalTools = allowGeneralEdits
    ? `- \`wiki_update\`: replace a page's body to fix a contradiction. Provide the FULL corrected body (no frontmatter). Preserve all unrelated content.
- \`wiki_patch\`: make a targeted exact old/new replacement for a contradiction instead of rewriting the full page.
`
    : '';
  const bypassRule = allowGeneralEdits
    ? ' Do not use `wiki_patch` or `wiki_update` to bypass the anchor requirement.'
    : '';

  return `You are a conservative wiki repair agent fixing quality issues in a personal knowledge base. You run as a background job: NO human will review or confirm your actions.

## Tools
- \`wiki_search\` / \`wiki_read\` / \`wiki_inspect\`: inspect pages. ALWAYS \`wiki_read\` a page's full body before editing it; for a contradiction, read the related page(s) too.
- \`wiki_link_ensure\`: maintain exactly one wikilink after \`wiki_read\` confirms a unique natural anchor already present in the source prose. The target identity is verified for validation only; the source page is the only page this tool writes.
${generalTools}

## Issue types
- **broken-link**: a [[wikilink]] whose target does not exist. PREFER \`wiki_link_ensure\` to retarget it to a verified existing page or unlink it while preserving the alias/display text as prose. NEVER invent a new page for a broken link — content-less stub pages are worse than plain text.
- **missing-crossref**: a concept with its own page is mentioned but not linked. PREFER \`wiki_link_ensure\` to wrap the FIRST unique natural mention already present in the source; do not duplicate links or invent anchor prose.
- **contradiction**: a page conflicts with another. Read both; make them consistent and faithful to the material. You MAY update BOTH pages. If you cannot tell which side is correct, leave it and move on — do NOT guess.

## Rules
- Faithful editing: never rewrite, summarise, reorder, or drop content beyond what an issue requires. If an edit is rejected (ok:false), you broke something — read the reason, try a smaller change, or skip.
- Only emit [[wikilinks]] to pages that exist; a broken or unresolved link causes the edit to be rejected.
- Never create or append a \`Related\` section or list.
- If you cannot find an existing unique natural anchor in the source body, skip that cross-reference.${bypassRule}
- Never touch the \`index\` or \`log\` pages. Do not translate slugs, titles, wikilink targets, or code.
- Edits are capped; when a tool returns ok:false (limit reached / protected / would leave a broken link), stop attempting that action.

## When done
Stop calling tools and briefly state what you fixed, or that nothing could be safely fixed.`;
}

/** 兼容既有调用方：常量保留 contradiction 的完整通用写提示。 */
export const FIX_AGENTIC_SYSTEM_PROMPT = buildFixAgenticSystemPrompt(true);

export function buildFixAgenticUserPrompt(
  reportLines: { slug: string; lines: string[] }[],
  roster: { slug: string; title: string }[],
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  const subjectSection = ctx.subject
    ? `## Active subject (workspace)\n- **Name**: ${ctx.subject.name}\n- **Slug**: \`${ctx.subject.slug}\`\n\n`
    : '';
  const report =
    reportLines.length > 0
      ? reportLines.map((p) => `### \`${p.slug}\`\n${p.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n')
      : '(no issues)';
  const rosterSection =
    roster.length > 0
      ? roster.map((p) => `- [[${p.title}]] (slug: \`${p.slug}\`)`).join('\n')
      : '(no other pages in this subject)';
  return `${languageDirective}${subjectSection}Below is the wiki's outstanding health report, grouped by page. Inspect each affected page with your tools and repair its issues conservatively (relink/unwrap broken links, add missing cross-references, reconcile contradictions). When you cannot fix something safely, leave it.

## Health report (${reportLines.length} page(s) with issues)
${report}

## Page roster (the ONLY valid wikilink targets in this subject)
${rosterSection}`;
}
