import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATEGORY,
  SETTINGS_CATEGORIES,
  SETTINGS_SECTIONS,
} from '../settings-categories';

describe('设置分类信息架构', () => {
  it('只暴露四个任务导向的一级入口，并默认进入 General', () => {
    expect(DEFAULT_CATEGORY).toBe('general');
    expect(SETTINGS_CATEGORIES.map((category) => category.id)).toEqual([
      'general',
      'personalization',
      'automation',
      'usage',
    ]);
  });

  it('将原有设置完整收纳到四个入口中', () => {
    expect(SETTINGS_SECTIONS).toEqual({
      general: ['appearance', 'language'],
      personalization: ['cognitive-lens'],
      automation: ['agents', 'web-search', 'maintenance'],
      usage: ['usage'],
    });
  });
});
