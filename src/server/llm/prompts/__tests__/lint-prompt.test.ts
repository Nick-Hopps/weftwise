import { describe, it, expect } from 'vitest';
import { buildLintUserPrompt } from '../lint-prompt';
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
});
