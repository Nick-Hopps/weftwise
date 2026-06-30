import { describe, it, expect } from 'vitest';
import { buildQueryUserPrompt, QUERY_AGENTIC_SYSTEM_PROMPT } from '../query-prompt';
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
  it('说明四工具、subject 隔离与 re-enrich 确认守则', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_list');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_search');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_read');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_reenrich');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/other subject/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/confirm before triggering/i);
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

describe('QUERY_AGENTIC_SYSTEM_PROMPT - 写工具纪律', () => {
  it('工具清单含 wiki_create / wiki_delete', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_create');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_delete');
  });
  it('删除段要求后续轮确认、禁止同轮删除', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/Deleting a page/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/confirm/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/LATER turn|later turn/);
  });
  it('创建段存在', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/Creating a page/i);
  });
});
