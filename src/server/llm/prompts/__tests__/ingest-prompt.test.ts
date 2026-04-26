import { describe, it, expect } from 'vitest';
import {
  buildPlanUserPrompt,
  buildPageBodyUserPrompt,
  buildIndexUserPrompt,
} from '../ingest-prompt';
import type { PromptContext } from '../prompt-context';

const ctxEnglish: PromptContext = { language: 'English' };
const ctxChinese: PromptContext = {
  language: 'Chinese',
  subject: { slug: 'general', name: 'General', description: '' },
};

describe('ingest prompt builders – language directive', () => {
  it('buildPlanUserPrompt prepends OUTPUT LANGUAGE with the configured language', () => {
    const out = buildPlanUserPrompt('source text', [], ctxChinese);
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
    expect(out).toMatch(/MUST be written in \*\*Chinese\*\*/);
    expect(out).toContain('source text');
  });

  it('buildPageBodyUserPrompt embeds the language directive', () => {
    const out = buildPageBodyUserPrompt(
      {
        slug: 'foo',
        title: 'Foo',
        summary: 's',
        outline: 'an outline',
        action: 'create',
      },
      'source text',
      ['Foo'],
      ctxEnglish,
    );
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
    expect(out).toMatch(/MUST be written in \*\*English\*\*/);
  });

  it('buildIndexUserPrompt embeds the language directive', () => {
    const out = buildIndexUserPrompt(
      [{ slug: 'foo', title: 'Foo', summary: 's' }],
      ctxChinese,
    );
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
    expect(out).toMatch(/MUST be written in \*\*Chinese\*\*/);
  });

  it('still renders the subject section when ctx.subject is set', () => {
    const out = buildPlanUserPrompt('source', [], ctxChinese);
    expect(out).toContain('General');
  });

  it('omits the subject section when ctx.subject is undefined', () => {
    const out = buildPlanUserPrompt('source', [], ctxEnglish);
    expect(out).not.toContain('Active subject');
  });
});
