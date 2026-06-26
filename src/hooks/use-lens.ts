'use client';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';

export interface LensResult {
  renderedMd: string;
  source: 'cache' | 'generated' | 'canonical' | 'fallback';
}

/**
 * 取当前 subject + 画像下某页的重塑正文；enabled=false 时不发请求。
 * queryKey 必须含 subjectSlug——同 vault 下不同 subject 可有同名 slug，
 * 缺它会跨主题串显缓存（同 wiki-link hover preview 的防串显约定）。
 */
export function useLens(subjectSlug: string, slug: string, enabled: boolean) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['lens', subjectSlug, slug],
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
