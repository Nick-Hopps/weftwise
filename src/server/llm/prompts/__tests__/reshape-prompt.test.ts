import { describe, it, expect } from 'vitest';
import {
  RESHAPE_PAGE_SYSTEM_PROMPT,
  buildReshapePageUserPrompt,
  buildReshapeSectionUserPrompt,
} from '../reshape-prompt';
import { DEFAULT_STYLE_PREFS } from '@/server/profile/style';
import type { PromptContext } from '../prompt-context';

const ctx: PromptContext = { language: 'Chinese' };
const profile = { backgroundSummary: '后端工程师，懂分布式', stylePrefs: DEFAULT_STYLE_PREFS };

describe('reshape-prompt', () => {
  it('system prompt 含保真约束关键词', () => {
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/fact|事实/i);
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/\[!/); // callout 标记规则
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/wikilink|\[\[/i);
  });

  it('page user prompt 注入语言指令 + 画像 + 正文', () => {
    const p = buildReshapePageUserPrompt('# 标题\n正文 [[X]]', profile, ctx);
    expect(p).toContain('Chinese'); // renderLanguageDirective
    expect(p).toContain('后端工程师'); // background
    expect(p).toContain('intermediate'); // readingLevel
    expect(p).toContain('正文 [[X]]'); // canonical body
  });

  it('section user prompt 含 direction 与待改块', () => {
    const p = buildReshapeSectionUserPrompt('某段', 'simpler', profile, ctx, '上文');
    expect(p).toMatch(/simpler|更简单|简单/i);
    expect(p).toContain('某段');
  });
});
