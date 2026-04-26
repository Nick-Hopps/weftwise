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
