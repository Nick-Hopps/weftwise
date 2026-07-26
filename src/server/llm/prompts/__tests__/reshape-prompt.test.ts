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

describe('reshape-prompt —— 已知概念地图注入（E2）', () => {
  const MAP = [
    "=== READER'S KNOWN CONCEPTS (this subject) ===",
    'Already solid — reference as [[slug]], do NOT re-explain:',
    '  [[gradient-descent]] Gradient Descent',
    'Anything not listed here: assume unfamiliar and explain it normally.',
  ].join('\n');

  it('零回归：不传地图时输出与不带该参数逐字节相同', () => {
    // 冷启动（全 unknown）时地图为 null，prompt 必须与本次改动前一模一样。
    const base = buildReshapePageUserPrompt('正文', profile, ctx);
    expect(buildReshapePageUserPrompt('正文', profile, ctx, null)).toBe(base);
    expect(buildReshapePageUserPrompt('正文', profile, ctx, undefined)).toBe(base);
    expect(base).not.toMatch(/KNOWN CONCEPTS/);
  });

  it('传地图时整段插在画像之后、正文之前', () => {
    const p = buildReshapePageUserPrompt('正文', profile, ctx, MAP);
    expect(p).toContain(MAP);
    expect(p.indexOf('READER PROFILE')).toBeLessThan(p.indexOf('KNOWN CONCEPTS'));
    expect(p.indexOf('KNOWN CONCEPTS')).toBeLessThan(p.indexOf('PAGE BODY TO RESHAPE'));
  });

  it('system prompt 说明该段只影响展开深度，缺席即照常全讲', () => {
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/KNOWN CONCEPTS/);
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/depth of explanation only/i);
    // 兜底：没有该段时行为不变，这是零回归的语义保证
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/absence[\s\S]*explain everything normally/i);
  });
});
