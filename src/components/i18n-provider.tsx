'use client';

import { createContext, useCallback, useContext, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n/config';
import { DEFAULT_LOCALE, localeCookie } from '@/lib/i18n/config';
import { createI18n, type I18n } from '@/lib/i18n/translator';

interface I18nContextValue extends I18n {
  setLocale: (locale: Locale) => void;
  isLocalePending: boolean;
}

const fallbackI18n: I18nContextValue = {
  ...createI18n(DEFAULT_LOCALE),
  setLocale: () => undefined,
  isLocalePending: false,
};

// 独立组件测试、Storybook 类孤立渲染安全回落英文；正式应用始终由根 Provider 覆盖。
const I18nContext = createContext<I18nContextValue>(fallbackI18n);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [locale, setLocaleState] = useState(initialLocale);
  const [isLocalePending, startTransition] = useTransition();

  const setLocale = useCallback(
    (nextLocale: Locale) => {
      if (nextLocale === locale) return;
      setLocaleState(nextLocale);
      document.documentElement.lang = nextLocale;
      document.cookie = localeCookie(nextLocale);
      startTransition(() => router.refresh());
    },
    [locale, router],
  );

  const value = useMemo(
    () => ({ ...createI18n(locale), setLocale, isLocalePending }),
    [isLocalePending, locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
