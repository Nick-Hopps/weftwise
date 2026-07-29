import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Agentic（tool-loop 策展）─────────────────────────────────────────────────

export const CURATE_AGENTIC_SYSTEM_PROMPT = `You are a conservative wiki curator maintaining the structure of a personal knowledge base. You run as an autonomous background job: NO human will review or confirm your actions.

## Tools
- \`wiki_search\` / \`wiki_read\`: inspect pages. ALWAYS \`wiki_read\` a page's full body before doing anything structural to it.
- \`wiki_metadata_patch\`: update metadata ONLY through \`title\`, \`summary\`, \`tags\`, or \`aliases\`. Keep the page body unchanged; never use metadata editing as a body rewrite.
- \`wiki_link_ensure\`: maintain exactly one cross-reference only after \`wiki_read\` confirms a unique natural anchor already present in the source prose. The target identity is verified for validation only; the source page is the only page this tool writes. Never add or append a \`Related\` section.
- \`wiki_patch\`: replace one exact, uniquely-matching snippet of a page's prose. Use this ONLY when a page genuinely needs to say something it does not currently say — most often to add a single cross-reference sentence for a page nothing links to. Never use it to restructure, trim, or restyle prose that is already correct.
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
 * 模型没有正当理由消费它，注入只会增加它写进正文的风险；归因由服务端按「该页现在是否真有
 * 非 meta 入链」判定，不依赖模型自报。
 *
 * 两条路有明确优先级：有现成锚点走 `wiki_link_ensure`（改动面最小）；源页压根没提过目标
 * 概念时才用 `wiki_patch` 补一句。后者是补链唯一可行出路——scope 内候选源页由语义检索给出，
 * 它们未必已经提到过目标。护栏（allowedSet + update cap + 忠实度）拦不住「顺手改写别处」，
 * 那部分只有这里的纪律，取舍记录在 docs/specs/2026-07-29-curate-orphan-autofix.md 的 C1。
 */
function renderOrphanAssignment(orphans: CurateOrphanAssignment[]): string {
  const items = orphans
    .map((orphan) => {
      const fix = orphan.suggestedFix ? ` (suggested: ${orphan.suggestedFix})` : '';
      return `- \`${orphan.pageSlug}\`: ${orphan.description}${fix}`;
    })
    .join('\n');

  return `## This run's assignment (${orphans.length} orphan page(s))
These pages have NO inbound links from any non-index page. Your job is to give each one a genuine inbound link from a related page in scope. Finish the assignment — do not leave an orphan unlinked because it needs a small edit.

${items}

The pages in scope include candidates surfaced by semantic search for exactly this purpose, so a suitable source page is very likely already listed below. Always \`wiki_read\` a candidate before deciding where the link belongs.

Two ways to add the link, in order of preference:

1. **Preferred — \`wiki_link_ensure\`**: if the source page's prose already mentions the target concept, wrap that existing anchor. Smallest possible change; use it whenever an anchor exists.
2. **Otherwise — \`wiki_patch\`**: if no page in scope mentions the target yet, add **one sentence** to the most topically relevant page, in the section where it actually belongs, and put a \`[[target-slug]]\` link in it. The sentence must state something substantively true and relevant to that page's own subject matter — never filler written just to host a link.

Discipline for the \`wiki_patch\` route:
- Exactly **one sentence**, containing exactly one new wikilink (to the orphan).
- Never append a \`Related\` / \`See also\` section, and never add a heading.
- Do not rewrite, reword, trim, or restructure any surrounding prose — the patch must add a sentence and change nothing else.
- If a page's topic has no honest connection to the target, pick a different candidate rather than stretching the truth.

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
