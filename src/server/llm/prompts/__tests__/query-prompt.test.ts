import { describe, it, expect } from 'vitest';
import { buildQueryUserPrompt } from '../query-prompt';
import type { PromptContext } from '../prompt-context';

const ctxChinese: PromptContext = {
  language: 'Chinese',
  subject: { slug: 'general', name: 'General', description: '' },
};

const ctxEnglish: PromptContext = { language: 'English' };

describe('buildQueryUserPrompt – language directive', () => {
  it('prepends OUTPUT LANGUAGE with the configured language', () => {
    const out = buildQueryUserPrompt('What is X?', [], ctxChinese);
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
    expect(out).toMatch(/MUST be written in \*\*Chinese\*\*/);
  });

  it('keeps the user question intact inside <user_input>', () => {
    const out = buildQueryUserPrompt('What is X?', [], ctxChinese);
    expect(out).toContain('What is X?');
    expect(out).toContain('<user_input>');
  });

  it('renders the subject section when ctx.subject is set', () => {
    const out = buildQueryUserPrompt('q', [], ctxChinese);
    expect(out).toContain('General');
    expect(out).toContain('Active subject');
  });

  it('omits the subject section when ctx.subject is undefined', () => {
    const out = buildQueryUserPrompt('q', [], ctxEnglish);
    expect(out).not.toContain('Active subject');
  });
});
