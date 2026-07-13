import { describe, expect, it } from 'vitest';

import { CURATE_AGENTIC_SYSTEM_PROMPT, buildCurateAgenticUserPrompt } from '../curate-prompt';

describe('CURATE_AGENTIC_SYSTEM_PROMPT', () => {
  it('列出结构写与两个窄写工具，且强调保守 + 无人确认', () => {
    for (const t of [
      'wiki_merge', 'wiki_split', 'wiki_delete', 'wiki_create', 'wiki_read',
      'wiki_metadata_patch', 'wiki_link_ensure',
    ]) {
      expect(CURATE_AGENTIC_SYSTEM_PROMPT).toContain(t);
    }
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/conservative/i);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/no human|NO human/);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/index|log/);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).not.toContain('wiki_list');
  });

  it('窄写要求先读、唯一自然锚点、target 只验证且禁止 Related 段', () => {
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/wiki_read[\s\S]*(unique|uniquely)[\s\S]*natural anchor/i);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/target[\s\S]*(validation|verify|verified)[\s\S]*source page/i);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/(never|do not)[\s\S]*(append|create|add)[\s\S]*Related/i);
  });

  it('metadata patch 仅允许四个 metadata 字段且不得改正文', () => {
    for (const field of ['title', 'summary', 'tags', 'aliases']) {
      expect(CURATE_AGENTIC_SYSTEM_PROMPT).toContain(field);
    }
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/metadata[\s\S]*(only|ONLY)[\s\S]*(body|prose)[\s\S]*(unchanged|never)/i);
  });
});

describe('buildCurateAgenticUserPrompt', () => {
  const pages = [{ slug: 'a', title: 'A', summary: 's', tags: ['t'], bodyChars: 100 }];
  const ctx = { language: 'English', subject: { slug: 'general', name: 'G', description: '' } };
  it('列出 scope 页 + auto 模式禁建/禁删提示', () => {
    const auto = buildCurateAgenticUserPrompt(pages, ctx, { auto: true });
    expect(auto).toContain('`a`');
    expect(auto).toMatch(/AUTOMATIC/);
    expect(auto).toMatch(/do NOT create or delete/i);
    expect(auto).not.toMatch(/delete redundant pages/i);
  });
  it('manual 模式无禁建页提示', () => {
    const manual = buildCurateAgenticUserPrompt(pages, ctx, { auto: false });
    expect(manual).toMatch(/MANUAL/);
    expect(manual).not.toMatch(/do NOT create/i);
    expect(manual).toMatch(/delete redundant pages/i);
  });
});
