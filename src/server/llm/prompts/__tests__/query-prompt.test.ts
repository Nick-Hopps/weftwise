import { describe, it, expect } from 'vitest';
import { buildQueryUserPrompt, QUERY_AGENTIC_SYSTEM_PROMPT, QueryResponseSchema } from '../query-prompt';
import type { PromptContext } from '../prompt-context';

const ctxChinese: PromptContext = {
  language: 'Chinese',
  subject: { slug: 'general', name: 'General', description: '' },
};

const ctxEnglish: PromptContext = { language: 'English' };

describe('buildQueryUserPrompt – language directive', () => {
  it('prepends OUTPUT LANGUAGE with the configured language', () => {
    const out = buildQueryUserPrompt('What is X?', [], ctxChinese);
    expect(out).toMatch(/^=== OUTPUT LANGUAGE ===/);
    expect(out).toMatch(/MUST be written in \*\*Chinese\*\*/);
  });

  it('keeps the user question intact inside <user_input>', () => {
    const out = buildQueryUserPrompt('What is X?', [], ctxChinese);
    expect(out).toContain('What is X?');
    expect(out).toContain('<user_input>');
  });

  it('renders the subject section when ctx.subject is set', () => {
    const out = buildQueryUserPrompt('q', [], ctxChinese);
    expect(out).toContain('General');
    expect(out).toContain('Active subject');
  });

  it('omits the subject section when ctx.subject is undefined', () => {
    const out = buildQueryUserPrompt('q', [], ctxEnglish);
    expect(out).not.toContain('Active subject');
  });
});

import { describe as describe2, it as it2, expect as expect2 } from 'vitest';

describe2('buildQueryUserPrompt – conversation history', () => {
  const ctx = { language: 'English' as const };

  it2('history 为空 → 不含 "Conversation so far" 段', () => {
    const out = buildQueryUserPrompt('What is X?', [], ctx);
    expect2(out).not.toContain('Conversation so far');
  });

  it2('history 非空 → 含 transcript 段且置于 User question 之前', () => {
    const out = buildQueryUserPrompt('追问？', [], ctx, [
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '第一个回答' },
    ]);
    expect2(out).toContain('Conversation so far');
    expect2(out).toContain('第一个问题');
    expect2(out).toContain('第一个回答');
    // transcript 段在 "User question" 之前
    expect2(out.indexOf('Conversation so far')).toBeLessThan(out.indexOf('User question'));
  });
});

import {
  buildAgenticUserContent,
} from '../query-prompt';

describe('QUERY_AGENTIC_SYSTEM_PROMPT', () => {
  it('只说明只读工具与 subject 隔离', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_list');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_search');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_read');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).not.toContain('wiki_reenrich');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/other subject/i);
  });

  it('明确跨主题列出、搜索、读取与带前缀引用纪律', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('subject_list');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_search_cross_subject');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_read_cross_subject');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('[[subject-slug:page-slug]]');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/never[\s\S]*cross-subject[\s\S]*write/i);
  });
});

describe('buildAgenticUserContent', () => {
  const ctx = {
    language: 'English',
    subject: { slug: 'general', name: 'General', description: '' },
  };

  it('含语言指令、subject 名、问题包在 <user_input>', () => {
    const out = buildAgenticUserContent('什么是 X', ctx);
    expect(out).toContain('General');
    expect(out).toContain('<user_input>\n什么是 X\n</user_input>');
  });

  it('传 currentPageSlug 时含当前页 hint', () => {
    const out = buildAgenticUserContent('总结这页', ctx, { currentPageSlug: 'foo' });
    expect(out).toContain('`foo`');
    expect(out).toMatch(/currently viewing/i);
  });

  it('不传 currentPageSlug 时不含 hint', () => {
    const out = buildAgenticUserContent('问题', ctx);
    expect(out).not.toMatch(/currently viewing/i);
  });
});

describe('QueryResponseSchema — coverage 字段', () => {
  it('coverageSufficient 必填，suggestedResearchQuestion 可选', () => {
    const parsed = QueryResponseSchema.parse({
      answer: 'a',
      citations: [],
      coverageSufficient: false,
      suggestedResearchQuestion: '这是一个待研究问题？',
    });
    expect(parsed.coverageSufficient).toBe(false);
    expect(parsed.suggestedResearchQuestion).toBe('这是一个待研究问题？');

    const withoutSuggestion = QueryResponseSchema.parse({
      answer: 'a', citations: [], coverageSufficient: true,
    });
    expect(withoutSuggestion.suggestedResearchQuestion).toBeUndefined();

    expect(() =>
      QueryResponseSchema.parse({ answer: 'a', citations: [] }),
    ).toThrow();
  });
});

describe('QUERY_AGENTIC_SYSTEM_PROMPT — web search 纪律', () => {
  it('提到 web_search 工具与来源标注要求', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('web_search');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/not in your wiki/i);
  });
});

describe('QUERY_AGENTIC_SYSTEM_PROMPT - 只读边界', () => {
  it('不宣称 Ask AI 可直接执行写操作或口头确认授权', () => {
    for (const tool of ['wiki_create', 'wiki_update', 'wiki_patch', 'wiki_delete', 'wiki_reenrich']) {
      expect(QUERY_AGENTIC_SYSTEM_PROMPT).not.toContain(tool);
    }
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).not.toMatch(/LATER turn|prior turn|confirm before/i);
  });

  it('仅允许通过审批预览工具提案，并明确预览不会直接落盘', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_preview_change');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/not applied/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/actionId/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/approval button/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).not.toMatch(/reply.*confirm/i);
  });

  it('窄写请求只指导 preview_change 的 operation，不暴露真实窄写工具', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('metadata-patch');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('link-ensure');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).not.toContain('wiki_metadata_patch');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).not.toContain('wiki_link_ensure');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/wiki_preview_change[\s\S]*metadata-patch/);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/wiki_preview_change[\s\S]*link-ensure/);
  });
});
