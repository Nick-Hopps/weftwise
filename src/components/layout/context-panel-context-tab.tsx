'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Link2, FileText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { SectionLabel } from '@/components/ui/panel';
import { TagLink } from '@/components/wiki/tag-link';

const MiniGraphView = dynamic(
  () => import('@/components/graph/mini-graph-view').then((m) => ({ default: m.MiniGraphView })),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-48 rounded-md border border-border bg-canvas flex items-center justify-center text-xs text-foreground-tertiary">
        Loading graph…
      </div>
    ),
  },
);

interface PageDetail {
  slug: string;
  title: string;
  content: string;
  frontmatter: {
    title: string;
    created: string;
    updated: string;
    tags: string[];
    sources: string[];
  } | null;
  backlinks: { slug: string; title: string }[];
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso || '—';
  }
}

interface ContextTabProps {
  slug: string | null;
}

export function ContextPanelContextTab({ slug }: ContextTabProps) {
  const apiFetch = useApiFetch();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();
  const { data: pageDetail, isLoading } = useQuery({
    queryKey: ['page-detail', subjectId, slug],
    queryFn: async () => {
      if (!slug) return null;
      const res = await apiFetch(`/api/pages/${slug}`);
      if (!res.ok) return null;
      return (await res.json()) as PageDetail;
    },
    enabled: !!slug && !!subjectId,
    staleTime: 30_000,
  });

  if (!slug) {
    return (
      <div className="flex flex-col items-center justify-center text-center px-6 py-12 gap-2 h-full">
        <FileText className="h-6 w-6 text-foreground-tertiary" aria-hidden />
        <p className="text-sm font-medium text-foreground">No page selected</p>
        <p className="text-xs text-foreground-secondary max-w-[240px]">
          Navigate to a wiki page to see its metadata, backlinks, and neighborhood graph here.
        </p>
      </div>
    );
  }

  const fm = pageDetail?.frontmatter;
  const backlinks = pageDetail?.backlinks ?? [];
  const wordCount = pageDetail?.content
    ? pageDetail.content.split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-4 space-y-6">
        {/* Metadata as property list */}
        <section aria-labelledby="ctx-meta">
          <SectionLabel id="ctx-meta" className="mb-2">
            Properties
          </SectionLabel>
          {isLoading || !pageDetail ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-4 rounded bg-subtle animate-pulse" />
              ))}
            </div>
          ) : (
            <dl className="grid grid-cols-[88px_1fr] gap-y-1.5 text-sm">
              <dt className="text-foreground-secondary">Created</dt>
              <dd className="font-mono text-xs text-foreground">
                {fm?.created ? formatDate(fm.created) : '—'}
              </dd>
              <dt className="text-foreground-secondary">Updated</dt>
              <dd className="font-mono text-xs text-foreground">
                {fm?.updated ? formatDate(fm.updated) : '—'}
              </dd>
              <dt className="text-foreground-secondary">Words</dt>
              <dd className="font-mono text-xs text-foreground tabular-nums">{wordCount}</dd>
              {fm?.tags && fm.tags.filter((t) => t !== 'meta').length > 0 && (
                <>
                  <dt className="text-foreground-secondary pt-0.5">Tags</dt>
                  <dd className="flex flex-wrap gap-1">
                    {fm.tags.filter((t) => t !== 'meta').map((t) => (
                      <TagLink key={t} tag={t} subjectSlug={subjectSlug} />
                    ))}
                  </dd>
                </>
              )}
            </dl>
          )}
        </section>

        {/* Backlinks */}
        <section aria-labelledby="ctx-backlinks">
          <SectionLabel id="ctx-backlinks" className="mb-2">
            Backlinks ({backlinks.length})
          </SectionLabel>
          {backlinks.length === 0 ? (
            <p className="text-xs text-foreground-tertiary italic">No backlinks yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {backlinks.map((link) => (
                <li key={link.slug} className="min-w-0">
                  <Link
                    href={`/wiki/${link.slug}`}
                    className="flex items-center gap-2 h-8 px-2 rounded-md text-sm text-foreground hover:bg-subtle transition-colors focus-ring min-w-0 w-full"
                  >
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" aria-hidden />
                    <span className="truncate min-w-0 flex-1">{link.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Graph — compact, interactive neighborhood view */}
        <section aria-labelledby="ctx-graph" className="flex-1 min-h-0">
          <div className="flex items-baseline justify-between mb-2">
            <SectionLabel id="ctx-graph">Graph</SectionLabel>
            <span className="text-[10px] text-foreground-tertiary italic">drag · scroll · click</span>
          </div>
          <MiniGraphView key={subjectId ?? 'no-subject'} currentSlug={slug} />
        </section>
      </div>
    </div>
  );
}
