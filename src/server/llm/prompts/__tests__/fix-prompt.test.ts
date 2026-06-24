import { describe, it, expect } from 'vitest';
import { FixPageSchema, buildFixPageUserPrompt } from '../fix-prompt';

const ctx = { language: 'English', subject: { slug: 'general', name: 'General', description: '' } };

describe('FixPageSchema', () => {
  it('接受合法对象', () => {
    const parsed = FixPageSchema.parse({ proceed: true, reason: 'fixed link', body: '# Hi' });
    expect(parsed.proceed).toBe(true);
  });

  it('proceed 必填', () => {
    expect(() => FixPageSchema.parse({ reason: 'x', body: 'y' })).toThrow();
  });
});

describe('buildFixPageUserPrompt', () => {
  const page = { slug: 'react', title: 'React', body: 'React is a UI library. See Hooks.' };
  const findings = [
    { type: 'broken-link', description: '[[Hookz]] does not exist', suggestedFix: 'fix the link' },
  ];
  const roster = [{ slug: 'hooks', title: 'Hooks' }];

  it('包含语言指令、findings、页名册', () => {
    const out = buildFixPageUserPrompt(page, findings, roster, ctx);
    expect(out).toContain('English');
    expect(out).toContain('[[Hookz]] does not exist');
    expect(out).toContain('Hooks');
    expect(out).toContain('react');
  });
});
