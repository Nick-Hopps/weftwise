'use client';

import { Hash } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { aggregateTags } from '@/lib/tags';
import { TagLink } from '@/components/wiki/tag-link';
import type { WikiPage } from '@/lib/contracts';

export function TagsIndexView() {
  const apiFetch = useApiFetch();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) return [] as WikiPage[];
      return (await res.json()) as WikiPage[];
    },
    enabled: !!subjectId,
    staleTime: 30_000,
  });

  const tags = aggregateTags(pages);

  return (
    <div className="max-w-content mx-auto px-6 py-8 w-full space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
          <Hash className="h-5 w-5 text-foreground-tertiary" />
          Tags
        </h1>
        <p className="mt-1 text-sm text-foreground-secondary">
          Browse pages by tag in this subject.
        </p>
      </header>

      {isLoading ? (
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-7 w-20 rounded-sm bg-subtle animate-pulse" />
          ))}
        </div>
      ) : tags.length === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No tags yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {tags.map(({ tag, count }) => (
            <li key={tag} className="inline-flex items-center gap-1">
              <TagLink tag={tag} subjectSlug={subjectSlug} size="base" />
              <span className="text-xs text-foreground-tertiary tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
