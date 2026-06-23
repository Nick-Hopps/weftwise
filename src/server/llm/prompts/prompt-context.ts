/**
 * Per-call context shared by every wiki-generation prompt builder.
 *
 * `language` is required and globally configured via the settings dialog
 * (persisted to the `app_settings` table; read via `settings-repo.getWikiLanguage()`).
 * `subject` is optional and per-call; when present the builder also emits
 * subject-scoping rules.
 */
export interface PromptContext {
  language: string;
  subject?: SubjectContextLite;
}

/**
 * Structural-only mirror of the SubjectContext shape used by individual
 * prompt files. Decouples this module from any one prompt file's interface.
 */
export interface SubjectContextLite {
  slug: string;
  name: string;
  description?: string;
}

/**
 * Renders a strongly-worded "OUTPUT LANGUAGE" block for the top of a user
 * prompt. Forbids translating identifiers (slugs, wikilink targets,
 * frontmatter keys, code), since translating them would silently break the
 * wiki graph.
 */
export function renderLanguageDirective(language: string): string {
  return [
    '=== OUTPUT LANGUAGE ===',
    `All natural-language content (page bodies, summaries, descriptions, log entries, citations, lint findings) MUST be written in **${language}**.`,
    '',
    'Do NOT translate or alter:',
    '- Slugs / page identifiers (kebab-case ASCII)',
    '- [[wikilink]] target names — keep them byte-for-byte identical to existing pages',
    '- Frontmatter keys (e.g. `title`, `tags`, `aliases`)',
    '- Code blocks and inline `code`',
    '- Proper nouns, library names, and APIs that have no idiomatic translation',
    '',
    `If the source document is in a different language, translate the substantive content into ${language} for the wiki, but preserve identifiers as above.`,
    '=== END OUTPUT LANGUAGE ===',
  ].join('\n');
}

/**
 * 渲染「AUGMENTATION LEVEL」块，注入 enricher user prompt，调节 callout 密度/深度。
 * `off` 不走 enricher（service 层直接跳过该阶段），故此函数只接 light/standard/deep。
 */
export function renderAugmentationDirective(level: 'light' | 'standard' | 'deep'): string {
  const guidance: Record<typeof level, string> = {
    light:
      'Add ONLY the 1–2 highest-value callouts per major section — prioritise one [!intuition] and at most one [!example]. Keep it sparse; most sections get no callout.',
    standard:
      'Add callouts at genuine points of difficulty — typically an [!intuition] plus an occasional [!example]/[!quiz]/[!pitfall] per major section. Aim for balanced, non-repetitive coverage.',
    deep:
      'Be generous: layer [!intuition], worked [!example]s, [!quiz] self-tests, [!background] prerequisites, [!diagram]s, and [!pitfall]s throughout. Maximise learning scaffolding while staying correct and on-topic.',
  };
  return [
    '=== AUGMENTATION LEVEL ===',
    guidance[level],
    'Regardless of level: never pad with low-confidence claims (a verifier stage scrutinises every callout), and never alter the faithful prose.',
    '=== END AUGMENTATION LEVEL ===',
  ].join('\n');
}
