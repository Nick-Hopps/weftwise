import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATEGORY,
  SETTINGS_CATEGORY_DEFINITIONS,
  SETTINGS_SECTIONS,
  getSettingsCategories,
} from '../settings-categories';
import { createI18n } from '@/lib/i18n/translator';

describe('设置分类信息架构', () => {
  it('只暴露四个任务导向的一级入口，并默认进入 General', () => {
    expect(DEFAULT_CATEGORY).toBe('general');
    expect(SETTINGS_CATEGORY_DEFINITIONS.map((category) => category.id)).toEqual([
      'general',
      'personalization',
      'automation',
      'usage',
    ]);
  });

  it('按当前界面语言生成分类文案', () => {
    const en = getSettingsCategories(createI18n('en').t);
    const zh = getSettingsCategories(createI18n('zh-CN').t);

    expect(en.map(({ label }) => label)).toEqual([
      'General',
      'Personalization',
      'Automation',
      'Usage',
    ]);
    expect(zh.map(({ label }) => label)).toEqual(['通用', '个性化', '自动化', '用量']);
  });

  it('将原有设置完整收纳到四个入口中', () => {
    expect(SETTINGS_SECTIONS).toEqual({
      general: ['language'],
      personalization: ['cognitive-lens'],
      automation: ['agents', 'web-search', 'maintenance'],
      usage: ['usage'],
    });
  });
});
