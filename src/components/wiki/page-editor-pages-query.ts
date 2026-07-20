import { queryOptions } from '@tanstack/react-query';
import { buildTitleSlugMap } from '@/lib/title-slug-map';
import type { WikiPage } from '@/lib/contracts';

type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function pageEditorPagesQueryOptions(apiFetch: ApiFetch, subjectId: string | null) {
  return queryOptions({
    queryKey: ['pages', subjectId],
    queryFn: async (): Promise<WikiPage[]> => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as WikiPage[];
    },
    select: buildTitleSlugMap,
    enabled: !!subjectId,
  });
}
