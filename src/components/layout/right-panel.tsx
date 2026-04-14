'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useUIStore } from '@/stores/ui-store';
import { apiFetch } from '@/lib/api-fetch';
import { ChatInterface } from '@/components/chat/chat-interface';

function ChevronRightIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

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

async function fetchPageDetail(slug: string): Promise<PageDetail | null> {
  const res = await apiFetch(`/api/pages/${slug}`);
  if (!res.ok) return null;
  return res.json();
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

export function RightPanel() {
  const { toggleRightPanel } = useUIStore();
  const pathname = usePathname();

  // Extract current wiki slug from URL
  const slugMatch = pathname.match(/^\/wiki\/(.+)$/);
  const currentSlug = slugMatch ? slugMatch[1] : null;

  const { data: pageDetail, isLoading } = useQuery({
    queryKey: ['page-detail', currentSlug],
    queryFn: () => currentSlug ? fetchPageDetail(currentSlug) : null,
    enabled: !!currentSlug,
    staleTime: 30_000,
  });

  const backlinks = pageDetail?.backlinks ?? [];
  const fm = pageDetail?.frontmatter;
  const wordCount = pageDetail?.content
    ? pageDetail.content.split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <div
      className="
        flex flex-col h-full
        w-[320px] lg:w-full
        bg-[rgb(var(--surface))]
        border-l border-[rgb(var(--border))]
        overflow-hidden
      "
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[rgb(var(--border))] shrink-0">
        <button
          onClick={toggleRightPanel}
          aria-label="Collapse context panel"
          className="p-1 rounded-md text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))] transition-colors"
        >
          <ChevronRightIcon />
        </button>
        <span className="text-xs font-semibold uppercase tracking-widest text-[rgb(var(--muted))]">
          Context
        </span>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto py-3 space-y-5 px-3">

        {!currentSlug ? (
          <p className="px-2 py-6 text-xs text-[rgb(var(--muted))] italic text-center">
            Navigate to a wiki page to see context
          </p>
        ) : isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-4 rounded bg-[rgb(var(--border))] animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {/* Backlinks section */}
            <section aria-labelledby="backlinks-heading">
              <h3
                id="backlinks-heading"
                className="text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))] mb-2"
              >
                Backlinks ({backlinks.length})
              </h3>
              {backlinks.length === 0 ? (
                <p className="px-2 text-xs text-[rgb(var(--muted))] italic">
                  No backlinks yet
                </p>
              ) : (
                <ul className="space-y-1">
                  {backlinks.map((link) => (
                    <li key={link.slug}>
                      <Link
                        href={`/wiki/${link.slug}`}
                        className="
                          w-full flex items-center gap-2
                          px-2 py-1.5 rounded-md
                          text-sm text-left
                          text-[rgb(var(--foreground))]
                          hover:bg-[rgb(var(--border))]
                          transition-colors
                        "
                      >
                        <span className="text-indigo-500 shrink-0">
                          <LinkIcon />
                        </span>
                        <span className="truncate">{link.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Metadata section */}
            <section aria-labelledby="metadata-heading">
              <h3
                id="metadata-heading"
                className="text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))] mb-2"
              >
                Metadata
              </h3>
              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-[rgb(var(--muted))]">Created</dt>
                  <dd className="text-[rgb(var(--foreground))] font-mono">
                    {fm?.created ? formatDate(fm.created) : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[rgb(var(--muted))]">Modified</dt>
                  <dd className="text-[rgb(var(--foreground))] font-mono">
                    {fm?.updated ? formatDate(fm.updated) : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-[rgb(var(--muted))]">Word count</dt>
                  <dd className="text-[rgb(var(--foreground))] font-mono">{wordCount}</dd>
                </div>
                {fm?.tags && fm.tags.length > 0 && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-[rgb(var(--muted))]">Tags</dt>
                    <dd className="text-[rgb(var(--foreground))] flex flex-wrap gap-1 justify-end">
                      {fm.tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400"
                        >
                          {tag}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            </section>

            {/* Graph mini-view — link to full graph */}
            <section aria-labelledby="graph-heading">
              <h3
                id="graph-heading"
                className="text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))] mb-2"
              >
                Graph
              </h3>
              <Link
                href="/graph"
                className="
                  flex items-center justify-center
                  rounded-lg h-20
                  border border-dashed border-[rgb(var(--border))]
                  bg-[rgb(var(--background))]
                  text-xs text-[rgb(var(--muted))]
                  hover:border-indigo-400 hover:text-indigo-500
                  transition-colors
                "
              >
                View full graph
              </Link>
            </section>
          </>
        )}

        {/* Chat — always visible regardless of current page */}
        <section className="flex-1 min-h-[300px] flex flex-col">
          <ChatInterface />
        </section>
      </div>
    </div>
  );
}
