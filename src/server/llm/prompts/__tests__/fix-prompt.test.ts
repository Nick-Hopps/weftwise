import { describe, it, expect } from 'vitest';
import { FIX_AGENTIC_SYSTEM_PROMPT, buildFixAgenticUserPrompt } from '../fix-prompt';

describe('buildFixAgenticUserPrompt', () => {
  it('嵌入诊断清单、roster 与语言指令', () => {
    const out = buildFixAgenticUserPrompt(
      [{ slug: 'eigen', lines: ['broken-link: [[Ghost]] missing'] }],
      [{ slug: 'matrix', title: 'Matrix' }],
      { language: 'English', subject: { slug: 'general', name: 'General', description: '' } },
    );
    expect(out).toContain('`eigen`');
    expect(out).toContain('broken-link: [[Ghost]] missing');
    expect(out).toContain('[[Matrix]]');
    expect(out).toMatch(/OUTPUT LANGUAGE/);
  });
});

describe('FIX_AGENTIC_SYSTEM_PROMPT', () => {
  it('规定保护页与忠实编辑纪律', () => {
    expect(FIX_AGENTIC_SYSTEM_PROMPT).toMatch(/index/);
    expect(FIX_AGENTIC_SYSTEM_PROMPT).toMatch(/log/);
    expect(FIX_AGENTIC_SYSTEM_PROMPT).toMatch(/[Ff]aithful/);
  });
});

describe('FIX_AGENTIC_SYSTEM_PROMPT — 无建页能力', () => {
  it('不再提及 wiki_create，并明令禁止为断链造页', () => {
    expect(FIX_AGENTIC_SYSTEM_PROMPT).not.toContain('wiki_create');
    expect(FIX_AGENTIC_SYSTEM_PROMPT).toMatch(/NEVER invent a new page/);
  });
});
