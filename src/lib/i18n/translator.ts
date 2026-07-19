import type { Locale } from './config';
import { messages, type MessageKey } from './messages';

export type MessageValues = Record<string, string | number>;
export type TranslationFunction = (key: MessageKey, values?: MessageValues) => string;

export function extractPlaceholders(message: string): string[] {
  return [...new Set(Array.from(message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (match) => match[1]))].sort();
}

/** 测试辅助：同时检查 key 集合和同 key 的命名占位符集合。 */
export function assertCatalogIntegrity(
  source: Record<string, string>,
  target: Record<string, string>,
): string[] {
  const sourceKeys = Object.keys(source).sort();
  const targetKeys = Object.keys(target).sort();
  const sourceSet = new Set(sourceKeys);
  const targetSet = new Set(targetKeys);
  const issues: string[] = [];

  for (const key of sourceKeys) {
    if (!targetSet.has(key)) issues.push(`missing:${key}`);
  }
  for (const key of targetKeys) {
    if (!sourceSet.has(key)) issues.push(`extra:${key}`);
  }
  for (const key of sourceKeys) {
    if (!targetSet.has(key)) continue;
    const sourcePlaceholders = extractPlaceholders(source[key]);
    const targetPlaceholders = extractPlaceholders(target[key]);
    if (sourcePlaceholders.join(',') !== targetPlaceholders.join(',')) {
      issues.push(`placeholders:${key}:${sourcePlaceholders.join(',')}!=${targetPlaceholders.join(',')}`);
    }
  }
  return issues;
}

function interpolate(message: string, values?: MessageValues): string {
  if (!values) return message;
  return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function createI18n(locale: Locale) {
  return {
    locale,
    t(key: MessageKey, values?: MessageValues): string {
      return interpolate(messages[locale][key], values);
    },
    formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
      const date = value instanceof Date ? value : new Date(value);
      return new Intl.DateTimeFormat(locale, options).format(date);
    },
    formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
      return new Intl.NumberFormat(locale, options).format(value);
    },
  };
}

export type I18n = ReturnType<typeof createI18n>;
