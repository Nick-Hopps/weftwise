'use client';

import Link from 'next/link';
import { Hash } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { pagesWithTag } from '@/lib/tags';
import type { WikiPage } from '@/lib/contracts';

export function TagPagesView({ tag }: { tag: string }) {
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

  const matched = pagesWithTag(pages, tag);

  return (
    <div className="max-w-content mx-auto px-6 py-8 w-full space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
          <Hash className="h-5 w-5 text-foreground-tertiary" />
          {tag}
        </h1>
        <Link href="/tags" className="mt-1 inline-block text-sm text-accent hover:underline">
          ← All tags
        </Link>
      </header>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-9 rounded-md bg-subtle animate-pulse" />
          ))}
        </div>
      ) : matched.length === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No pages with this tag.</p>
      ) : (
        <ul className="space-y-0.5">
          {matched.map((p) => (
            <li key={p.slug}>
              <Link
                href={`/wiki/${p.slug}?s=${encodeURIComponent(subjectSlug)}`}
                className="flex items-center gap-2 h-9 px-3 rounded-md text-sm text-foreground hover:bg-subtle transition-colors focus-ring"
              >
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
