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

import { SettingsContent } from '../settings-content';

describe('General 设置内容', () => {
  it('只显示语言设置，不再显示深色模式和侧栏宽度', () => {
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
    expect(html).not.toContain('Dark mode');
    expect(html).not.toContain('Sidebar width');
  });
});
