import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createI18n } from '@/lib/i18n/translator';

Object.assign(globalThis, { React });

vi.mock('@/components/i18n-provider', () => {
  const i18n = createI18n('en');
  return {
    useI18n: () => ({
      ...i18n,
      setLocale: vi.fn(),
      isLocalePending: false,
    }),
  };
});

import { SettingsContent, usageQueryPath } from '../settings-content';

describe('General 设置内容', () => {
  it('显示语言与阅读设置，不再显示深色模式和侧栏宽度', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsContent, {
        active: 'general',
        settings: undefined,
        settingsLoading: true,
        saveLanguage: {
          mutate: vi.fn(),
          isPending: false,
          isError: false,
          error: undefined,
        },
        savePartial: {
          mutate: vi.fn(),
          isPending: false,
          isError: false,
          error: undefined,
        },
      }),
    );

    expect(html).toContain('Interface language');
    expect(html).toContain('Wiki language');
    expect(html).toContain('Reading');
    expect(html).toContain('Body font size');
    expect(html).toContain('value="16"');
    expect(html).toContain('min="14"');
    expect(html).toContain('max="22"');
    expect(html).not.toContain('Dark mode');
    expect(html).not.toContain('Sidebar width');
  });

  it('语言设置合并进单一卡片 section，不再拆「界面 / 内容语言」两组', () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsContent, {
        active: 'general',
        settings: undefined,
        settingsLoading: true,
        saveLanguage: {
          mutate: vi.fn(),
          isPending: false,
          isError: false,
          error: undefined,
        },
        savePartial: {
          mutate: vi.fn(),
          isPending: false,
          isError: false,
          error: undefined,
        },
      }),
    );

    // 旧的独立 section 标题已删除。
    expect(html).not.toContain('Content language');
    // 两行同处一个 divide-y 卡片容器。
    expect(html.match(/divide-y/g)).toHaveLength(2);
  });
});

describe('Usage 项目过滤', () => {
  it('项目筛选进入请求 URL，全部项目不附带 subjectId', () => {
    expect(usageQueryPath('30d', 'all')).toBe('/api/usage?window=30d');
    expect(usageQueryPath('7d', 'subject/a'))
      .toBe('/api/usage?window=7d&subjectId=subject%2Fa');
  });
});
