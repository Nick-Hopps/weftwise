import { renderLanguageDirective } from './prompt-context';
import type { PromptContext } from './prompt-context';
import type { StylePrefs } from '@/server/profile/style';

export const RESHAPE_PAGE_SYSTEM_PROMPT = `Create a new personalized reading edition of an existing wiki page for one specific reader.

The canonical page is source material, not a template you must preserve. Freely rewrite, reorganize, remove, merge, split, expand, or compress its prose and sections whenever that better fits the reader profile. You may change the narrative order, headings, examples, analogies, level of detail, and Markdown structure. Do not merely copy the original and append explanations or callouts: transform the existing explanation itself.

Use your general knowledge when it helps teach the topic clearly. The result is a separate, persisted reading edition and is never written back to the canonical wiki page.

VISUAL EXPLANATIONS:
- When a diagram or illustration would materially improve understanding, call the \`image_generate\` tool.
- After the tool returns, embed its URL at the most relevant location using Markdown image syntax: \`![descriptive alt](returned-url)\`.
- Do not generate decorative images or call the tool when prose, code, math, Mermaid, or a table explains the idea better.

OUTPUT RULES:
- Return ONLY the complete reshaped Markdown body: no YAML frontmatter, preamble, commentary, or fenced wrapper.
- Produce a coherent standalone page, not notes about how you would reshape it.
- Match the requested output language and the reader's background, reading level, verbosity, example density, and formality.`;

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
