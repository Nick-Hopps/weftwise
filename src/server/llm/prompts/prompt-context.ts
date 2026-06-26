import type { AugmentationLevel } from '@/lib/contracts';

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

/**
 * 渲染「EXPOSITION DEPTH」块，注入 writer user prompt，决定讲解深度。
 * 与 renderAugmentationDirective 对称，但接收全部四档：`off` 退回纯忠实渲染
 *（writer 不引入来源外知识、不加 callout，等价旧 v5 行为），其余档递增讲解力度。
 */
export function renderExpositionDirective(level: AugmentationLevel): string {
  if (level === 'off') {
    return [
      '=== EXPOSITION DEPTH ===',
      'FAITHFUL MODE: render ONLY what the source chunks contain. Do NOT add background, analogies, derivations, examples, or any knowledge not present in the chunks. Write plain, accurate, well-structured encyclopedic prose. No callouts.',
      '=== END EXPOSITION DEPTH ===',
    ].join('\n');
  }
  const guidance: Record<'light' | 'standard' | 'deep', string> = {
    light:
      'Explain for understanding but stay concise: a clear definition, the core "why", and one intuition where a reader would otherwise be lost. Add outside knowledge sparingly and only when it removes a real obstacle.',
    standard:
      'Write a self-contained teaching article. Beyond faithfully covering the source, weave into the prose: motivation (why this exists / why it is defined this way), needed prerequisites, the underlying mechanism, an analogy or intuition, at least one worked example built from simple to harder, contrasts with adjacent concepts, and common pitfalls. Draw on your own knowledge to fill gaps the source leaves, staying correct and on-topic.',
    deep:
      'Write an exhaustive, deeply explanatory article a motivated learner could internalise the topic from alone: definition, motivation, history/context, prerequisites, mechanism, multiple analogies, several worked examples of increasing difficulty, edge cases, contrasts with related ideas, common misconceptions, and applications — all woven into the prose, generously drawing on your own knowledge while staying correct.',
  };
  return [
    '=== EXPOSITION DEPTH ===',
    guidance[level],
    'All added explanation must be correct and on-topic; a later verifier stage fact-checks the prose, so never assert low-confidence claims as fact. Never translate slugs, [[wikilink]] targets, frontmatter keys, or code.',
    '=== END EXPOSITION DEPTH ===',
  ].join('\n');
}
