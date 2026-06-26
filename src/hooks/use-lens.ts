'use client';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';

export interface LensResult {
  renderedMd: string;
  source: 'cache' | 'generated' | 'canonical' | 'fallback';
}

/** 取当前 subject + 画像下某页的重塑正文；enabled=false 时不发请求。 */
export function useLens(slug: string, enabled: boolean) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['lens', slug],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<LensResult> => {
      const path = `/api/lens/${slug.split('/').map(encodeURIComponent).join('/')}`;
      const res = await apiFetch(path);
      if (!res.ok) throw new Error(`lens ${res.status}`);
      return res.json();
    },
  });
}
