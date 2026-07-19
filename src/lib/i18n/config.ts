export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE_NAME = 'wiki_locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** 将浏览器/cookie 中常见的语言标签收敛为首版支持的两个 locale。 */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const normalized = value.trim().replaceAll('_', '-').toLowerCase();
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  return null;
}

interface LocaleCandidate {
  locale: Locale;
  quality: number;
  index: number;
}

function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const candidates: LocaleCandidate[] = [];
  for (const [index, rawPart] of header.split(',').entries()) {
    const [rawTag, ...parameters] = rawPart.trim().split(';');
    const locale = normalizeLocale(rawTag);
    if (!locale) continue;

    let quality = 1;
    const qualityParameter = parameters.find((part) => part.trim().toLowerCase().startsWith('q='));
    if (qualityParameter) {
      const parsed = Number(qualityParameter.trim().slice(2));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) continue;
      quality = parsed;
    }
    if (quality === 0) continue;
    candidates.push({ locale, quality, index });
  }

  candidates.sort((a, b) => b.quality - a.quality || a.index - b.index);
  return candidates[0]?.locale ?? null;
}

export function resolveLocale({
  cookieLocale,
  acceptLanguage,
}: {
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  return normalizeLocale(cookieLocale) ?? localeFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}

export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}
