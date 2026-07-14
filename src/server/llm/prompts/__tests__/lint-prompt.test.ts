import { describe, it, expect } from 'vitest';
import {
  LINT_SYSTEM_PROMPT,
  LintResultSchema,
  buildLintUserPrompt,
} from '../lint-prompt';
import type { PromptContext } from '../prompt-context';

const ctxJapanese: PromptContext = {
  language: 'Japanese',
  subject: { slug: 'general', name: 'General', description: '' },
};

const ctxEnglish: PromptContext = { language: 'English' };

const samplePages = [
  { slug: 'foo', title: 'Foo', content: 'body of foo' },
];

describe('buildLintUserPrompt – language directive', () => {
  it('prepends OUTPUT LANGUAGE with the configured language', () => {
    const out = buildLintUserPrompt(samplePages, ctxJapanese);
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
    expect(out).toMatch(/MUST be written in \*\*Japanese\*\*/);
  });

  it('renders the subject section when ctx.subject is set', () => {
    const out = buildLintUserPrompt(samplePages, ctxJapanese);
    expect(out).toContain('General');
    expect(out).toContain('Active subject');
  });

  it('omits the subject section when ctx.subject is undefined', () => {
    const out = buildLintUserPrompt(samplePages, ctxEnglish);
    expect(out).not.toContain('Active subject');
  });

  it('still emits the directive when pages array is empty', () => {
    const out = buildLintUserPrompt([], ctxJapanese);
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
    expect(out).toContain('Japanese');
    expect(out).toContain('No wiki pages provided');
  });

  it('要求可由服务端核验的目标与逐页原文证据', () => {
    expect(LINT_SYSTEM_PROMPT).toContain('targetSlug');
    expect(LINT_SYSTEM_PROMPT).toContain('exact, verbatim quote');
    expect(LINT_SYSTEM_PROMPT).not.toContain('better to flag a false positive');

    expect(LintResultSchema.safeParse({
      findings: [{
        type: 'missing-crossref',
        severity: 'warning',
        pageSlug: 'source',
        targetSlug: 'target',
        evidence: [{ pageSlug: 'source', quote: 'Target is discussed here.' }],
        description: 'The source mentions Target without a link.',
        suggestedFix: 'Link Target.',
      }],
    }).success).toBe(true);
  });
});
