import { renderLanguageDirective } from './prompt-context';
import type { PromptContext } from './prompt-context';
import type { StylePrefs } from '@/server/profile/style';

export const RESHAPE_PAGE_SYSTEM_PROMPT = `You reshape an existing wiki page for one specific reader. This is PRESENTATION ONLY.

HARD RULES (never violate):
- Do NOT add, remove, or change any FACT. Same claims, same numbers, same conclusions.
- Do NOT introduce any new [[wikilink]]. You may keep or drop existing ones, but never invent or alter a link target.
- Any analogy, worked example, or prerequisite primer you ADD for the reader MUST be wrapped in a callout: \`> [!example]\` or \`> [!note]\`. Plain factual statements must stay outside callouts.
- Output ONLY the reshaped markdown body — no frontmatter, no preamble, no "here is".
- Preserve markdown structure (headings, lists, code blocks, math) where it still serves the reader.

GOAL: match the reader's background and style preferences so the page is as easy to internalize as possible for THEM — neither over-explaining what they already know nor under-explaining what they don't.`;

export const RESHAPE_SECTION_SYSTEM_PROMPT = `You reshape ONE block of a wiki page for one reader. PRESENTATION ONLY.
Same hard rules as page reshaping: no fact changes, no new wikilinks, added scaffolding wrapped in \`> [!example]\`/\`> [!note]\`, output only the reshaped block markdown.`;

function renderProfile(profile: { backgroundSummary: string; stylePrefs: StylePrefs }): string {
  const s = profile.stylePrefs;
  return [
    '=== READER PROFILE ===',
    `Background: ${profile.backgroundSummary || '(unknown — assume a curious generalist)'}`,
    `Reading level: ${s.readingLevel}`,
    `Verbosity: ${s.verbosity}`,
    `Example/analogy density: ${s.exampleDensity}`,
    `Formality: ${s.formality}`,
  ].join('\n');
}

export function buildReshapePageUserPrompt(
  body: string,
  profile: { backgroundSummary: string; stylePrefs: StylePrefs },
  ctx: PromptContext,
): string {
  return [
    renderLanguageDirective(ctx.language),
    '',
    renderProfile(profile),
    '',
    '=== PAGE BODY TO RESHAPE (canonical) ===',
    body,
    '',
    '=== OUTPUT ===',
    'Return the reshaped markdown body only.',
  ].join('\n');
}

export function buildReshapeSectionUserPrompt(
  block: string,
  direction: 'simpler' | 'deeper',
  profile: { backgroundSummary: string; stylePrefs: StylePrefs },
  ctx: PromptContext,
  context?: string,
): string {
  return [
    renderLanguageDirective(ctx.language),
    '',
    renderProfile(profile),
    '',
    '=== DIRECTION ===',
    direction === 'simpler'
      ? 'Make this block SIMPLER / easier to grasp for this reader.'
      : 'Make this block DEEPER / more thorough for this reader.',
    context ? `\n=== SURROUNDING CONTEXT (do not rewrite) ===\n${context}` : '',
    '',
    '=== BLOCK TO RESHAPE ===',
    block,
    '',
    '=== OUTPUT ===',
    'Return the reshaped block markdown only.',
  ].join('\n');
}
