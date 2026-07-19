import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  normalizeLocale,
  resolveLocale,
} from '@/lib/i18n/config';
import { messages } from '@/lib/i18n/messages';
import {
  assertCatalogIntegrity,
  createI18n,
  extractPlaceholders,
} from '@/lib/i18n/translator';

describe('locale resolution', () => {
  it('uses the supported locale cookie before Accept-Language', () => {
    expect(resolveLocale({ cookieLocale: 'en', acceptLanguage: 'zh-CN,zh;q=0.9' })).toBe('en');
    expect(LOCALE_COOKIE_NAME).toBe('wiki_locale');
  });

  it('normalizes Chinese and English aliases', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('ZH_hans')).toBe('zh-CN');
    expect(normalizeLocale('zh-cn')).toBe('zh-CN');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr-FR')).toBeNull();
  });

  it('honors Accept-Language quality weights when the cookie is absent or invalid', () => {
    expect(resolveLocale({ acceptLanguage: 'en;q=0.5, zh-CN;q=0.9' })).toBe('zh-CN');
    expect(resolveLocale({ cookieLocale: 'invalid', acceptLanguage: 'en-GB,zh;q=0.8' })).toBe('en');
  });

  it('falls back to English for unsupported or malformed input', () => {
    expect(resolveLocale({ acceptLanguage: 'fr-FR,de;q=0.8' })).toBe(DEFAULT_LOCALE);
    expect(resolveLocale({ acceptLanguage: ';;;q=nope' })).toBe(DEFAULT_LOCALE);
  });
});

describe('message catalogs', () => {
  it('keeps English and Chinese keys and placeholders in lockstep', () => {
    expect(assertCatalogIntegrity(messages.en, messages['zh-CN'])).toEqual([]);
  });

  it('reports missing, extra, and placeholder-drifted messages', () => {
    expect(
      assertCatalogIntegrity(
        { greeting: 'Hello {name}', stable: 'Stable' },
        { greeting: '你好 {person}', extra: '额外' },
      ),
    ).toEqual([
      'missing:stable',
      'extra:extra',
      'placeholders:greeting:name!=person',
    ]);
  });

  it('extracts each named placeholder once', () => {
    expect(extractPlaceholders('{count} pages by {name}; again {count}')).toEqual(['count', 'name']);
  });
});

describe('translator', () => {
  it('translates and interpolates named values', () => {
    const en = createI18n('en');
    const zh = createI18n('zh-CN');

    expect(en.t('common.items', { count: 3 })).toBe('3 items');
    expect(zh.t('common.items', { count: 3 })).toBe('3 项');
  });

  it('formats dates and numbers with the explicit locale', () => {
    const date = new Date('2026-07-20T08:00:00.000Z');
    const zh = createI18n('zh-CN');

    expect(zh.formatDate(date, { dateStyle: 'medium', timeZone: 'UTC' })).toBe(
      new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'UTC' }).format(date),
    );
    expect(zh.formatNumber(1234567)).toBe(new Intl.NumberFormat('zh-CN').format(1234567));
  });
});
