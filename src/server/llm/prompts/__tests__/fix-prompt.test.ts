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

describe('buildFixPageUserPrompt — extra 只读上下文', () => {
  const page = { slug: 'react', title: 'React', body: 'React body' };
  const findings = [
    { type: 'contradiction', description: 'conflicts with vue', suggestedFix: null },
  ];
  const roster = [{ slug: 'vue', title: 'Vue' }];

  it('传 subjectReport 渲染全局报告段', () => {
    const out = buildFixPageUserPrompt(page, findings, roster, ctx, {
      subjectReport: [{ slug: 'vue', lines: ['contradiction: conflicts with react'] }],
    });
    expect(out).toContain('Subject-wide health report');
    expect(out).toContain('contradiction: conflicts with react');
  });

  it('传 relatedPages 渲染关联页段且含正文', () => {
    const out = buildFixPageUserPrompt(page, findings, roster, ctx, {
      relatedPages: [{ title: 'Vue', slug: 'vue', body: 'Vue is a framework.' }],
    });
    expect(out).toContain('Related pages');
    expect(out).toContain('Vue is a framework.');
  });

  it('relatedPages 为空数组不渲染该段', () => {
    const out = buildFixPageUserPrompt(page, findings, roster, ctx, { relatedPages: [] });
    expect(out).not.toContain('Related pages');
  });

  it('不传 extra（或空对象）与基线逐字一致', () => {
    const base = buildFixPageUserPrompt(page, findings, roster, ctx);
    const withEmpty = buildFixPageUserPrompt(page, findings, roster, ctx, {});
    expect(withEmpty).toBe(base);
    expect(base).not.toContain('Subject-wide health report');
    expect(base).not.toContain('Related pages');
  });
});
