'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Menu, Moon, PanelRight, Search, Sun, Sparkles } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { SubjectSwitcher } from './subject-switcher';
import { IngestPill } from './ingest-pill';
import { cn } from '@/lib/cn';
import { displayTitleForSlug } from '@/lib/path-display';

interface PageLite {
  slug: string;
  title: string;
}

function Breadcrumb({ pathname }: { pathname: string }) {
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();
  const { data: pages } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) return [] as PageLite[];
      return (await res.json()) as PageLite[];
    },
    staleTime: 30_000,
    enabled: !!subjectId,
  });

  const segments: Array<{ label: string; href?: string }> = [];
  if (pathname === '/' || pathname === '') {
    segments.push({ label: 'Dashboard' });
  } else if (pathname.startsWith('/wiki/')) {
    const slug = pathname.replace(/^\/wiki\//, '');
    segments.push({ label: 'Wiki', href: '/' });
    segments.push({ label: displayTitleForSlug(slug, pages) });
  } else {
    segments.push({ label: pathname.replace(/^\/+/, ''), href: pathname });
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
      {segments.map((seg, idx) => {
        const last = idx === segments.length - 1;
        return (
          <span key={idx} className="flex items-center gap-1.5 min-w-0">
            {idx > 0 && (
              <span aria-hidden className="text-foreground-tertiary text-xs">/</span>
            )}
            {seg.href && !last ? (
              <Link
                href={seg.href}
                className="text-sm text-foreground-secondary hover:text-foreground transition-colors truncate"
              >
                {seg.label}
              </Link>
            ) : (
              <span
                className={cn(
                  'text-sm truncate',
                  last ? 'text-foreground font-medium' : 'text-foreground-secondary',
                )}
              >
                {seg.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function Header() {
  const pathname = usePathname() ?? '/';
  const {
    toggleSidebar,
    toggleCommandPalette,
    toggleDarkMode,
    darkMode,
    contextPanelOpen,
    toggleContextPanel,
    openAskAi,
  } = useUIStore();

  const isWikiRoute = pathname.startsWith('/wiki/');

  return (
    <header className="z-header flex h-header shrink-0 items-center gap-3 border-b border-border-subtle bg-surface/95 px-3 backdrop-blur-md sm:px-4">
      {/* Left: logo + breadcrumb. The sidebar is resizable but not collapsible
          on desktop (per design); only a mobile hamburger remains. */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <IconButton
          size="base"
          onClick={toggleSidebar}
          aria-label="Open navigation"
          data-tip="Open navigation"
          className="tip tip-b lg:hidden"
        >
          <Menu />
        </IconButton>

        <Link
          href="/"
          aria-label="Agentic Wiki — home"
          className="flex items-center gap-2 rounded-sm px-1 focus-ring"
        >
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-fg shadow-xs">
            {/* Network glyph — a linked "vault" mark with an accent-cored hub node */}
            <svg width="24" height="24" viewBox="0 0 40 40" fill="none" aria-hidden>
              <path
                d="M9 13 L13.5 27 L20 16 L26.5 27 L31 13"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.9"
              />
              <circle cx="9" cy="13" r="2.8" fill="currentColor" />
              <circle cx="13.5" cy="27" r="2.8" fill="currentColor" />
              <circle cx="26.5" cy="27" r="2.8" fill="currentColor" />
              <circle cx="31" cy="13" r="2.8" fill="currentColor" />
              <circle cx="20" cy="16" r="3.9" fill="currentColor" />
              <circle cx="20" cy="16" r="1.7" className="fill-accent" />
            </svg>
          </span>
          <span className="hidden font-display text-[16px] font-semibold tracking-normal text-foreground sm:inline">
            Agentic Wiki
          </span>
        </Link>

        <SubjectSwitcher />

        <span aria-hidden className="hidden md:inline text-xs text-foreground-tertiary mx-1">/</span>
        <div className="hidden md:flex min-w-0">
          <Breadcrumb pathname={pathname} />
        </div>
      </div>

      {/* Center: search trigger */}
      <button
        type="button"
        onClick={toggleCommandPalette}
        aria-label="Open search (Ctrl+K)"
        className="hidden h-8 w-[300px] max-w-[34vw] items-center gap-2 rounded-md border border-border bg-canvas/80 px-3 text-xs text-foreground-tertiary shadow-xs transition-colors hover:border-border-strong hover:bg-subtle focus-ring sm:flex"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">Search pages, ask AI…</span>
        <Kbd>⌘K</Kbd>
      </button>

      {/* Background-ingest progress (visible while an ingest runs in the background) */}
      <IngestPill />

      {/* Right: icon actions */}
      <div className="flex items-center gap-1 shrink-0">
        <IconButton
          size="base"
          onClick={toggleCommandPalette}
          aria-label="Search"
          data-tip="Search"
          className="tip tip-b sm:hidden"
        >
          <Search />
        </IconButton>

        <IconButton
          size="base"
          onClick={() => openAskAi()}
          aria-label="Ask your wiki (⌘J)"
          data-tip="Ask your wiki"
          className="tip tip-b text-accent hover:text-accent-hover"
        >
          <Sparkles />
        </IconButton>

        <IconButton
          size="base"
          onClick={toggleDarkMode}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          data-tip={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          className="tip tip-b"
        >
          {darkMode ? <Sun /> : <Moon />}
        </IconButton>

        {isWikiRoute && (
          <IconButton
            size="base"
            onClick={toggleContextPanel}
            aria-label={contextPanelOpen ? 'Close context panel' : 'Open context panel'}
            data-tip={contextPanelOpen ? 'Hide context panel' : 'Show context panel'}
            className={cn('tip tip-b', contextPanelOpen && 'bg-subtle text-foreground')}
          >
            <PanelRight />
            <span className="sr-only">context</span>
          </IconButton>
        )}
      </div>
    </header>
  );
}
