import { describe, expect, it } from 'vitest';
import { buildMergeUserPrompt, MergeResultSchema, MERGE_SYSTEM_PROMPT } from '../merge-prompt';

const ctx = { language: 'English', subject: { slug: 'general', name: 'General' } };

describe('buildMergeUserPrompt', () => {
  it('注入语言指令 + 两页标题与正文', () => {
    const out = buildMergeUserPrompt(
      { title: 'Alpha', body: 'alpha body' },
      { title: 'Beta', body: 'beta body' },
      ctx,
    );
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('Alpha');
    expect(out).toContain('alpha body');
    expect(out).toContain('Beta');
    expect(out).toContain('beta body');
  });

  it('包含保留 wikilink 的指令', () => {
    const out = buildMergeUserPrompt({ title: 'A', body: '' }, { title: 'B', body: '' }, ctx);
    expect(out.toLowerCase()).toContain('wikilink');
  });
});

describe('MergeResultSchema', () => {
  it('接受合法对象', () => {
    expect(MergeResultSchema.parse({ mergedBody: 'x', mergedSummary: 'y' }))
      .toEqual({ mergedBody: 'x', mergedSummary: 'y' });
  });
  it('缺字段报错', () => {
    expect(MergeResultSchema.safeParse({ mergedBody: 'x' }).success).toBe(false);
  });
});

describe('MERGE_SYSTEM_PROMPT', () => {
  it('是非空字符串', () => {
    expect(typeof MERGE_SYSTEM_PROMPT).toBe('string');
    expect(MERGE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
