'use client';

import Link from 'next/link';
import { Hash } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { aggregateTags, tagCloudWeights, shuffleTagsDeterministic } from '@/lib/tags';
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

  const tags = shuffleTagsDeterministic(tagCloudWeights(aggregateTags(pages)));

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 w-full space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
          <Hash className="h-5 w-5 text-foreground-tertiary" />
          Tags
        </h1>
        <p className="mt-1 text-sm text-foreground-secondary">
          Browse pages by tag in this subject.
        </p>
      </header>

      {!subjectId || isLoading ? (
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-7 w-20 rounded-sm bg-subtle animate-pulse" />
          ))}
        </div>
      ) : tags.length === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No tags yet.</p>
      ) : (
        <ul className="flex flex-wrap items-baseline justify-center gap-x-4 gap-y-2 py-4">
          {tags.map(({ tag, count, weight }) => (
            <li key={tag}>
              <Link
                href={`/tags/${encodeURIComponent(tag)}${subjectSlug ? `?s=${encodeURIComponent(subjectSlug)}` : ''}`}
                title={`${count} page${count === 1 ? '' : 's'}`}
                className="text-accent hover:underline whitespace-nowrap leading-tight"
                style={{
                  fontSize: `${(0.875 + weight * 1.625).toFixed(3)}rem`,
                  opacity: 0.45 + weight * 0.55,
                }}
              >
                {tag}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
