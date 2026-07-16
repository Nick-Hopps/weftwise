'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

type SearchParamValue = string | string[] | null;

/** Tags 两个视图共用的 URL 状态更新器，保留 Subject 与其他未知参数。 */
export function useTagSearchParams() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const updateSearchParams = useCallback((updates: Record<string, SearchParamValue>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      next.delete(key);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item) next.append(key, item);
        }
      } else if (value) {
        next.set(key, value);
      }
    }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  return { searchParams, updateSearchParams };
}
