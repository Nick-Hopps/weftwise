import { describe, expect, it } from 'vitest';
import { normalizeResearchQuestion } from '../research-question';

describe('normalizeResearchQuestion', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeResearchQuestion('  What is X?  ')).toBe('what is x?');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeResearchQuestion('What   is\n\tX?')).toBe('what is x?');
  });

  it('lowercases', () => {
    expect(normalizeResearchQuestion('WHAT IS X?')).toBe('what is x?');
  });

  it('treats equivalent questions as identical after normalization', () => {
    const a = normalizeResearchQuestion('  What Is X?  ');
    const b = normalizeResearchQuestion('what   is x?');
    expect(a).toBe(b);
  });
});
