import { describe, it, expect } from 'vitest';
import {
  buildQueryAgenticSystemPrompt,
  buildQueryUserPrompt,
  buildSelectionIntentUserPrompt,
  QueryResponseSchema,
  SELECTION_INTENT_SYSTEM_PROMPT,
  SelectionIntentSchema,
} from '../query-prompt';
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
  const prompt = buildQueryAgenticSystemPrompt({ mode: 'read', imageInsertEnabled: false });

  it('说明受治理工具与 subject 隔离', () => {
    expect(prompt).toContain('wiki_list');
    expect(prompt).toContain('wiki_search');
    expect(prompt).toContain('wiki_read');
    expect(prompt).toContain('workflow_status');
    expect(prompt).toMatch(/other subject/i);
  });

  it('明确跨主题列出、搜索、读取与带前缀引用纪律', () => {
    expect(prompt).toContain('subject_list');
    expect(prompt).toContain('wiki_search_cross_subject');
    expect(prompt).toContain('wiki_read_cross_subject');
    expect(prompt).toContain('[[subject-slug:page-slug]]');
    expect(prompt).toMatch(/never[\s\S]*cross-subject[\s\S]*write/i);
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
    const prompt = buildQueryAgenticSystemPrompt({ mode: 'read', imageInsertEnabled: false });
    expect(prompt).toContain('web_search');
    expect(prompt).toMatch(/not in your wiki/i);
  });
});

describe('QUERY_AGENTIC_SYSTEM_PROMPT - 只读边界', () => {
  const readPrompt = buildQueryAgenticSystemPrompt({ mode: 'read', imageInsertEnabled: false });
  const proposePrompt = buildQueryAgenticSystemPrompt({ mode: 'propose', imageInsertEnabled: false });
  const imagePrompt = buildQueryAgenticSystemPrompt({ mode: 'propose', imageInsertEnabled: true });

  it('不宣称 Ask AI 可直接执行写操作或口头确认授权', () => {
    for (const tool of ['wiki_create', 'wiki_update', 'wiki_patch', 'wiki_delete']) {
      expect(proposePrompt).not.toContain(tool);
    }
    expect(proposePrompt).not.toMatch(/LATER turn|prior turn|confirm before/i);
  });

  it('read prompt 不描述未下发的 mutation 工具', () => {
    for (const tool of [
      'wiki_preview_change',
      'history_revert',
      'workflow_reenrich_start',
      'workflow_research_start',
      'workflow_cancel',
      'wiki_move',
      'wiki_image_insert',
    ]) {
      expect(readPrompt).not.toContain(tool);
    }
  });

  it('propose prompt 的启动与取消只走 PendingAction，并说明 Research 二次审批', () => {
    expect(proposePrompt).toContain('workflow_reenrich_start');
    expect(proposePrompt).toContain('workflow_research_start');
    expect(proposePrompt).toContain('workflow_cancel');
    expect(proposePrompt).toMatch(/research candidates[\s\S]*separate approval/i);
    expect(proposePrompt).toMatch(/workflow_status[\s\S]*workflow_cancel/);
    expect(proposePrompt).toMatch(/does not enqueue|does not cancel/i);
  });

  it('只有 imageInsertEnabled prompt 描述选区配图工具', () => {
    expect(proposePrompt).not.toContain('wiki_image_insert');
    expect(imagePrompt).toContain('wiki_image_insert');
    expect(imagePrompt).toMatch(/read the current page first/i);
    expect(imagePrompt).toMatch(/does not call the image model|after the user clicks Approve/i);
    expect(imagePrompt).not.toContain('image_generate');
  });

  it('仅允许通过审批预览工具提案，并明确预览不会直接落盘', () => {
    expect(proposePrompt).toContain('wiki_preview_change');
    expect(proposePrompt).toContain('history_list');
    expect(proposePrompt).toContain('history_diff');
    expect(proposePrompt).toContain('history_revert');
    expect(proposePrompt).toMatch(/not applied/i);
    expect(proposePrompt).toMatch(/actionId/i);
    expect(proposePrompt).toMatch(/approval button/i);
    expect(proposePrompt).not.toMatch(/reply.*confirm/i);
  });

  it('History 回滚要求 list → diff → PendingAction，且禁止猜 operation id', () => {
    expect(proposePrompt).toMatch(/history_list[\s\S]*history_diff/);
    expect(proposePrompt).toMatch(/Never guess an operation id/i);
    expect(proposePrompt).toMatch(/history_diff[\s\S]*history_revert/);
    expect(proposePrompt).toMatch(/never applies the revert/i);
  });

  it('窄写请求只指导 preview_change 的 operation，不暴露真实窄写工具', () => {
    expect(proposePrompt).toContain('metadata-patch');
    expect(proposePrompt).toContain('link-ensure');
    expect(proposePrompt).not.toContain('wiki_metadata_patch');
    expect(proposePrompt).not.toContain('wiki_link_ensure');
    expect(proposePrompt).toMatch(/wiki_preview_change[\s\S]*metadata-patch/);
    expect(proposePrompt).toMatch(/wiki_preview_change[\s\S]*link-ensure/);
  });
});

describe('SelectionIntentSchema', () => {
  it('只接受 image-insert 或 other', () => {
    expect(SelectionIntentSchema.parse({ intent: 'image-insert' })).toEqual({ intent: 'image-insert' });
    expect(SelectionIntentSchema.parse({ intent: 'other' })).toEqual({ intent: 'other' });
    expect(() => SelectionIntentSchema.parse({ intent: 'delete-page' })).toThrow();
  });

  it('prompt 明确区分执行意图、能力询问、否定与已有图片解释', () => {
    expect(SELECTION_INTENT_SYSTEM_PROMPT).toMatch(/explicitly asks[\s\S]*now[\s\S]*generate[\s\S]*insert/i);
    expect(SELECTION_INTENT_SYSTEM_PROMPT).toMatch(/capability|negated|existing image/i);
    expect(buildSelectionIntentUserPrompt('在这下面生成一张图片说明'))
      .toContain('<user_input>\n在这下面生成一张图片说明\n</user_input>');
  });
});
