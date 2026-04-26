import { describe, it, expect } from 'vitest';
import { renderLanguageDirective } from '../prompt-context';

describe('renderLanguageDirective', () => {
  it('puts the language name in the MUST instruction line', () => {
    const out = renderLanguageDirective('Chinese');
    expect(out).toMatch(/MUST be written in \*\*Chinese\*\*/);
  });

  it('explicitly forbids translating slugs / wikilinks / frontmatter keys / code', () => {
    const out = renderLanguageDirective('Japanese');
    expect(out).toMatch(/slug/i);
    expect(out).toMatch(/wikilink|\[\[/i);
    expect(out).toMatch(/frontmatter/i);
    expect(out).toMatch(/code/i);
  });

  it('starts with a clear OUTPUT LANGUAGE marker', () => {
    const out = renderLanguageDirective('English');
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
  });

  it('renders deterministically for the same input', () => {
    expect(renderLanguageDirective('English')).toBe(renderLanguageDirective('English'));
  });
});
