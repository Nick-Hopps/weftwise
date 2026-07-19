'use client';

import { createContext, useCallback, useContext, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n/config';
import { localeCookie } from '@/lib/i18n/config';
import { createI18n, type I18n } from '@/lib/i18n/translator';

interface I18nContextValue extends I18n {
  setLocale: (locale: Locale) => void;
  isLocalePending: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

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
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used within I18nProvider');
  return context;
}
