import 'server-only';

import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE_NAME, resolveLocale } from './config';
import { createI18n } from './translator';

export async function getServerLocale() {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  return resolveLocale({
    cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: requestHeaders.get('accept-language'),
  });
}

export async function getServerI18n() {
  return createI18n(await getServerLocale());
}
