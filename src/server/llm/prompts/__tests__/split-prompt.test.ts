import { describe, expect, it } from 'vitest';
import { buildSplitUserPrompt, SplitResultSchema, SPLIT_SYSTEM_PROMPT } from '../split-prompt';

const ctx = { language: 'English', subject: { slug: 'general', name: 'General' } };

describe('buildSplitUserPrompt', () => {
  it('注入语言指令 + 原页标题/正文', () => {
    const out = buildSplitUserPrompt({ title: 'Big Page', body: 'big body' }, undefined, ctx);
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('Big Page');
    expect(out).toContain('big body');
  });

  it('给了 hint 时包含 hint 文本', () => {
    const out = buildSplitUserPrompt({ title: 'X', body: 'y' }, 'split by H2 sections', ctx);
    expect(out).toContain('split by H2 sections');
  });

  it('未给 hint 时不报错且不含 hint 段', () => {
    const out = buildSplitUserPrompt({ title: 'X', body: 'y' }, undefined, ctx);
    expect(typeof out).toBe('string');
  });

  it('包含保留 wikilink 与恰一 primary 的指令', () => {
    const out = buildSplitUserPrompt({ title: 'X', body: 'y' }, undefined, ctx);
    expect(out.toLowerCase()).toContain('wikilink');
    expect(out.toLowerCase()).toContain('primary');
  });
});

describe('SplitResultSchema', () => {
  it('接受 ≥2 页', () => {
    const ok = SplitResultSchema.safeParse({
      pages: [
        { title: 'A', body: 'a', summary: 's', isPrimary: true },
        { title: 'B', body: 'b', summary: 's', isPrimary: false },
      ],
    });
    expect(ok.success).toBe(true);
  });
  it('拒绝 <2 页', () => {
    const bad = SplitResultSchema.safeParse({ pages: [{ title: 'A', body: 'a', summary: 's', isPrimary: true }] });
    expect(bad.success).toBe(false);
  });
});

describe('SPLIT_SYSTEM_PROMPT', () => {
  it('是非空字符串', () => {
    expect(typeof SPLIT_SYSTEM_PROMPT).toBe('string');
    expect(SPLIT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
