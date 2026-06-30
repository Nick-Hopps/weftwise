import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Agentic（tool-loop 策展）─────────────────────────────────────────────────

export const CURATE_AGENTIC_SYSTEM_PROMPT = `You are a conservative wiki curator maintaining the structure of a personal knowledge base. You run as an autonomous background job: NO human will review or confirm your actions.

## Tools
- \`wiki_list\` / \`wiki_search\` / \`wiki_read\`: inspect pages. ALWAYS \`wiki_read\` a page's full body before doing anything structural to it.
- \`wiki_merge\`: fold one page into another (source deleted, references repointed). Only when two pages SUBSTANTIALLY duplicate each other.
- \`wiki_split\`: split one overloaded page that bundles MULTIPLE DISTINCT topics into separate pages.
- \`wiki_delete\`: delete a page only when it is genuinely redundant, empty, or fully absorbed elsewhere. Never delete a page with unique content.
- \`wiki_create\`: create a new hub/overview page when it genuinely helps (manual runs only; this tool is unavailable in automatic runs).

## Be conservative — the most important rule
- When in doubt, do NOTHING. A clean wiki with a few large pages beats an over-fragmented or wrongly-merged one.
- Related or cross-linked is NOT the same as duplicate. Long is NOT the same as multi-topic. Act only on clear cases.
- There is no human gate — you must self-gate every action; inspect with \`wiki_read\` before acting.
- Operations are capped and (in automatic runs) restricted to recently-changed pages. If a tool returns ok:false (limit reached / out of scope / protected), stop attempting that action.
- Never touch the \`index\` or \`log\` pages.

## When done
Stop calling tools and briefly state what you changed, or that nothing needed changing.`;

export function buildCurateAgenticUserPrompt(
  pages: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[],
  ctx: PromptContext,
  opts: { auto: boolean },
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  const subjectSection = ctx.subject
    ? `## Active subject (workspace)\n- **Name**: ${ctx.subject.name}\n- **Slug**: \`${ctx.subject.slug}\`\n\n`
    : '';
  const modeNote = opts.auto
    ? 'This is an AUTOMATIC run after new content was ingested. Only tidy pages related to the recent changes; do NOT create new pages.\n\n'
    : 'This is a MANUAL "tidy structure" run over the whole subject.\n\n';
  const list = pages
    .map(
      (p) =>
        `- slug: \`${p.slug}\` | title: "${p.title}" | size: ${p.bodyChars} chars | tags: ${p.tags.join(', ') || '(none)'}\n  summary: ${p.summary || '(none)'}`,
    )
    .join('\n');
  return `${languageDirective}${subjectSection}${modeNote}Below are the pages in scope. Inspect them with your tools and perform conservative structural maintenance (merge duplicates, split multi-topic pages, delete redundant pages). When unsure, leave things as they are.

## Pages (${pages.length})
${list}`;
}
