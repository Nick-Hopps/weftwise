import { describe, it, expect } from 'vitest';
import {
  FIX_AGENTIC_SYSTEM_PROMPT,
  buildFixAgenticSystemPrompt,
  buildFixAgenticUserPrompt,
} from '../fix-prompt';

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

describe('FIX_AGENTIC_SYSTEM_PROMPT — 窄链接修复纪律', () => {
  const linksPrompt = buildFixAgenticSystemPrompt(false);

  it('broken-link / missing-crossref 优先 link ensure，并要求先读唯一自然锚点', () => {
    expect(linksPrompt).toContain('wiki_link_ensure');
    expect(linksPrompt).toMatch(/broken-link[\s\S]*wiki_link_ensure/);
    expect(linksPrompt).toMatch(/missing-crossref[\s\S]*wiki_link_ensure/);
    expect(linksPrompt).toMatch(/wiki_read[\s\S]*(unique|uniquely)[\s\S]*natural anchor/i);
  });

  it('target 仅用于验证，不扩大 source 写范围', () => {
    expect(linksPrompt).toMatch(/target[\s\S]*(validation|verify|verified)[\s\S]*source page/i);
  });

  it('禁止创建或追加 Related 段落/列表', () => {
    expect(linksPrompt).toMatch(
      /(never|do not)[\s\S]*(create|append|add)[\s\S]*Related[\s\S]*(section|list)/i,
    );
  });

  it('找不到正文中现有且唯一的自然锚点时跳过，不得用通用写工具绕过', () => {
    expect(linksPrompt).toMatch(
      /cannot find[\s\S]*existing[\s\S]*unique natural anchor[\s\S]*skip/i,
    );
    expect(buildFixAgenticSystemPrompt(true)).toMatch(
      /do not use[\s\S]*wiki_patch[\s\S]*wiki_update[\s\S]*bypass/i,
    );
  });
});

describe('buildFixAgenticSystemPrompt', () => {
  it('links profile 不暴露 wiki_update/wiki_patch 文案', () => {
    const prompt = buildFixAgenticSystemPrompt(false);
    expect(prompt).not.toContain('wiki_update');
    expect(prompt).not.toContain('wiki_patch');
  });

  it('contradiction profile 包含通用 update/patch 工具说明', () => {
    const prompt = buildFixAgenticSystemPrompt(true);
    expect(prompt).toContain('wiki_update');
    expect(prompt).toContain('wiki_patch');
  });
});
