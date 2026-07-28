import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Agentic（tool-loop 策展）─────────────────────────────────────────────────

export const CURATE_AGENTIC_SYSTEM_PROMPT = `You are a conservative wiki curator maintaining the structure of a personal knowledge base. You run as an autonomous background job: NO human will review or confirm your actions.

## Tools
- \`wiki_search\` / \`wiki_read\`: inspect pages. ALWAYS \`wiki_read\` a page's full body before doing anything structural to it.
- \`wiki_metadata_patch\`: update metadata ONLY through \`title\`, \`summary\`, \`tags\`, or \`aliases\`. Keep the page body unchanged; never use metadata editing as a body rewrite.
- \`wiki_link_ensure\`: maintain exactly one cross-reference only after \`wiki_read\` confirms a unique natural anchor already present in the source prose. The target identity is verified for validation only; the source page is the only page this tool writes. Never add or append a \`Related\` section.
- \`wiki_merge\`: fold one page into another (source deleted, references repointed). Only when two pages SUBSTANTIALLY duplicate each other.
- \`wiki_split\`: split one overloaded page that bundles MULTIPLE DISTINCT topics into separate pages.
- \`wiki_delete\`: delete a page only when it is genuinely redundant, empty, or fully absorbed elsewhere (manual runs only; unavailable in automatic runs). Never delete a page with unique content.
- \`wiki_create\`: create a new hub/overview page when it genuinely helps (manual runs only; this tool is unavailable in automatic runs).

## Be conservative — the most important rule
- When in doubt, do NOTHING. A clean wiki with a few large pages beats an over-fragmented or wrongly-merged one.
- Related or cross-linked is NOT the same as duplicate. Long is NOT the same as multi-topic. Act only on clear cases.
- There is no human gate — you must self-gate every action; inspect with \`wiki_read\` before acting.
- Operations are capped and (in automatic runs) restricted to recently-changed pages. If a tool returns ok:false (limit reached / out of scope / protected), stop attempting that action.
- Never touch the \`index\` or \`log\` pages.

## When done
Stop calling tools and briefly state what you changed, or that nothing needed changing.`;

export interface CurateOrphanAssignment {
  pageSlug: string;
  description: string;
  suggestedFix: string | null;
}

/**
 * Health 派来的 orphan 工单。只注入事实（页面 + 描述 + 建议），**不注入 finding ID** ——
 * 模型没有正当理由消费它，注入只会增加它写进正文的风险；归因始终由服务端
 * postcondition 的 touchedSlugs 完成。
 *
 * 同时显式给出「找不到自然锚点就不要写」这条出路：邻域里确实可能没有任何页面提到目标
 * 概念，此时正确答案就是不写。逼模型交付只会让它伪造锚点或新建 Related 段落，而两者都
 * 会被 wiki_link_ensure 硬拒，白烧 token。
 */
function renderOrphanAssignment(orphans: CurateOrphanAssignment[]): string {
  const items = orphans
    .map((orphan) => {
      const fix = orphan.suggestedFix ? ` (suggested: ${orphan.suggestedFix})` : '';
      return `- \`${orphan.pageSlug}\`: ${orphan.description}${fix}`;
    })
    .join('\n');

  return `## This run's assignment (${orphans.length} orphan page(s))
These pages have NO inbound links from any non-index page. Your goal is to give each one a genuine inbound link from a related page in scope.

${items}

Use \`wiki_link_ensure\` for this, and only on an anchor that ALREADY exists verbatim in the source page's prose. If no page in scope contains a natural anchor for a target, do NOT write anything for it — instead state which pages you checked and why no anchor exists. Inventing an anchor, or appending a \`Related\` section, is worse than leaving the orphan alone.

`;
}

export function buildCurateAgenticUserPrompt(
  pages: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[],
  ctx: PromptContext,
  opts: { auto: boolean; orphans?: CurateOrphanAssignment[] },
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  const subjectSection = ctx.subject
    ? `## Active subject (workspace)\n- **Name**: ${ctx.subject.name}\n- **Slug**: \`${ctx.subject.slug}\`\n\n`
    : '';
  const modeNote = opts.auto
    ? 'This is an AUTOMATIC run after new content was ingested. Only tidy pages related to the recent changes; do NOT create or delete pages.\n\n'
    : 'This is a MANUAL "tidy structure" run over the whole subject.\n\n';
  const list = pages
    .map(
      (p) =>
        `- slug: \`${p.slug}\` | title: "${p.title}" | size: ${p.bodyChars} chars | tags: ${p.tags.join(', ') || '(none)'}\n  summary: ${p.summary || '(none)'}`,
    )
    .join('\n');
  const allowedActions = opts.auto
    ? 'merge duplicates, split multi-topic pages, adjust metadata, or add one evidence-backed natural cross-reference'
    : 'merge duplicates, split multi-topic pages, delete redundant pages, create a useful hub, adjust metadata, or add one evidence-backed natural cross-reference';
  const assignmentSection = opts.orphans && opts.orphans.length > 0
    ? renderOrphanAssignment(opts.orphans)
    : '';
  return `${languageDirective}${subjectSection}${modeNote}${assignmentSection}Below are the pages in scope. Inspect them with your tools and perform conservative structural maintenance (${allowedActions}). When unsure, leave things as they are.

## Pages (${pages.length})
${list}`;
}
