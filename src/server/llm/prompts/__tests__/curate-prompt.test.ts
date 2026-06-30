import { describe, expect, it } from 'vitest';

import { CURATE_AGENTIC_SYSTEM_PROMPT, buildCurateAgenticUserPrompt } from '../curate-prompt';

describe('CURATE_AGENTIC_SYSTEM_PROMPT', () => {
  it('列出四个写工具且强调保守 + 无人确认', () => {
    for (const t of ['wiki_merge', 'wiki_split', 'wiki_delete', 'wiki_create', 'wiki_read']) {
      expect(CURATE_AGENTIC_SYSTEM_PROMPT).toContain(t);
    }
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/conservative/i);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/no human|NO human/);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/index|log/);
  });
});

describe('buildCurateAgenticUserPrompt', () => {
  const pages = [{ slug: 'a', title: 'A', summary: 's', tags: ['t'], bodyChars: 100 }];
  const ctx = { language: 'English', subject: { slug: 'general', name: 'G', description: '' } };
  it('列出 scope 页 + auto 模式禁建页提示', () => {
    const auto = buildCurateAgenticUserPrompt(pages, ctx, { auto: true });
    expect(auto).toContain('`a`');
    expect(auto).toMatch(/AUTOMATIC/);
    expect(auto).toMatch(/do NOT create/i);
  });
  it('manual 模式无禁建页提示', () => {
    const manual = buildCurateAgenticUserPrompt(pages, ctx, { auto: false });
    expect(manual).toMatch(/MANUAL/);
    expect(manual).not.toMatch(/do NOT create/i);
  });
});
