import { describe, it, expect } from 'vitest';
import {
  RESHAPE_PAGE_SYSTEM_PROMPT,
  buildReshapePageUserPrompt,
} from '../reshape-prompt';
import { DEFAULT_STYLE_PREFS } from '@/server/profile/style';
import type { PromptContext } from '../prompt-context';

const ctx: PromptContext = { language: 'Chinese' };
const profile = { backgroundSummary: '后端工程师，懂分布式', stylePrefs: DEFAULT_STYLE_PREFS };

describe('reshape-prompt', () => {
  it('system prompt 明确允许按画像自由调整原文，而非只追加说明', () => {
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/rewrite|reorganize|remove|expand/i);
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/do not merely|not merely|instead of merely/i);
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).not.toMatch(/do NOT add, remove, or change any FACT/i);
  });

  it('system prompt 允许按需生图并要求嵌入返回 URL', () => {
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/image_generate/i);
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/markdown image/i);
  });

  it('page user prompt 注入语言指令 + 画像 + 正文', () => {
    const p = buildReshapePageUserPrompt('# 标题\n正文 [[X]]', profile, ctx);
    expect(p).toContain('Chinese'); // renderLanguageDirective
    expect(p).toContain('后端工程师'); // background
    expect(p).toContain('intermediate'); // readingLevel
    expect(p).toContain('正文 [[X]]'); // canonical body
  });

  it('不暴露未实现的段级重塑 Prompt', async () => {
    const promptExports = await import('../reshape-prompt');

    expect(promptExports).not.toHaveProperty('RESHAPE_SECTION_SYSTEM_PROMPT');
    expect(promptExports).not.toHaveProperty('buildReshapeSectionUserPrompt');
  });
});
