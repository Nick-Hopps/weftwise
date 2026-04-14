'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useUIStore } from '@/stores/ui-store';
import { apiFetch } from '@/lib/api-fetch';

const SIDEBAR_PAGE_LIMIT = 100;

function ChevronLeftIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

interface PageItem {
  slug: string;
  title: string;
  updatedAt: string;
}

async function fetchPages(): Promise<PageItem[]> {
  const res = await apiFetch('/api/pages');
  if (!res.ok) return [];
  return res.json();
}

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps = {}) {
  const { toggleSidebar } = useUIStore();
  const pathname = usePathname();
  const [showAllPages, setShowAllPages] = useState(false);

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['pages'],
    queryFn: fetchPages,
    staleTime: 30_000,
  });

  // Sort by updatedAt descending for recent pages
  const recentPages = [...pages]
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
    .slice(0, 8);

  // All pages sorted alphabetically
  const allPages = [...pages].sort((a, b) =>
    a.title.localeCompare(b.title)
  );

  const isActive = (slug: string) => pathname === `/wiki/${slug}`;

  return (
    <div
      className="
        flex flex-col h-full
        w-[280px]
        bg-[rgb(var(--surface))]
        border-r border-[rgb(var(--border))]
        overflow-hidden
      "
    >
      {/* Sidebar header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[rgb(var(--border))] shrink-0">
        <span className="text-xs font-semibold uppercase tracking-widest text-[rgb(var(--muted))]">
          Pages
        </span>
        <button
          onClick={toggleSidebar}
          aria-label="Collapse sidebar"
          className="p-1 rounded-md text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))] transition-colors"
        >
          <ChevronLeftIcon />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto py-2">
        {isLoading ? (
          <div className="px-4 py-3 space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-6 rounded bg-[rgb(var(--border))] animate-pulse" />
            ))}
          </div>
        ) : pages.length === 0 ? (
          <p className="px-4 py-6 text-xs text-[rgb(var(--muted))] italic text-center">
            No pages yet. Ingest a source to get started.
          </p>
        ) : (
          <>
            {/* Recent Pages */}
            <div className="px-2 mb-4">
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-[rgb(var(--muted))]">
                Recent
              </p>
              <nav aria-label="Recent pages">
                {recentPages.map((page) => (
                  <Link
                    key={page.slug}
                    href={`/wiki/${page.slug}`}
                    onClick={onNavigate}
                    className={`
                      w-full flex items-center gap-2
                      px-2 py-1.5 rounded-md text-sm
                      transition-colors
                      ${isActive(page.slug)
                        ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400'
                        : 'text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]'
                      }
                    `}
                  >
                    <span className="text-[rgb(var(--muted))]">
                      <FileIcon />
                    </span>
                    <span className="truncate">{page.title}</span>
                  </Link>
                ))}
              </nav>
            </div>

            {/* All Pages */}
            <div className="px-2">
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-[rgb(var(--muted))]">
                All Pages ({allPages.length})
              </p>
              <nav aria-label="All pages">
                {(showAllPages ? allPages : allPages.slice(0, SIDEBAR_PAGE_LIMIT)).map((page) => (
                  <Link
                    key={page.slug}
                    href={`/wiki/${page.slug}`}
                    onClick={onNavigate}
                    className={`
                      w-full flex items-center gap-2
                      px-2 py-1.5 rounded-md text-sm
                      transition-colors
                      ${isActive(page.slug)
                        ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400'
                        : 'text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]'
                      }
                    `}
                  >
                    <span className="text-[rgb(var(--muted))]">
                      <FileIcon />
                    </span>
                    <span className="truncate">{page.title}</span>
                  </Link>
                ))}
              </nav>
              {!showAllPages && allPages.length > SIDEBAR_PAGE_LIMIT && (
                <button
                  onClick={() => setShowAllPages(true)}
                  className="w-full px-2 py-2 text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
                >
                  Show all {allPages.length} pages
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Bottom action */}
      <div className="p-3 border-t border-[rgb(var(--border))] shrink-0">
        <Link
          href="/ingest"
          onClick={onNavigate}
          className="
            w-full flex items-center justify-center gap-2
            px-3 py-2 rounded-md
            bg-emerald-500 hover:bg-emerald-600
            text-white text-sm font-medium
            transition-colors
          "
        >
          <PlusIcon />
          New Ingest
        </Link>
      </div>
    </div>
  );
}
