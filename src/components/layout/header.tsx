'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Menu, Moon, Search, SidebarOpen, SidebarClose, Sun, Sparkles } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { SubjectSwitcher } from './subject-switcher';
import { cn } from '@/lib/cn';

interface PageLite {
  slug: string;
  title: string;
}

function titleForSlug(slug: string, pages: PageLite[] | undefined): string {
  return pages?.find((p) => p.slug === slug)?.title ?? slug;
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
    segments.push({ label: titleForSlug(slug, pages) });
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
    sidebarOpen,
    toggleSidebar,
    toggleCommandPalette,
    toggleDarkMode,
    darkMode,
    contextPanelOpen,
    toggleContextPanel,
    openContextPanel,
  } = useUIStore();

  const isWikiRoute = pathname.startsWith('/wiki/');

  return (
    <header className="flex items-center gap-3 h-header px-3 border-b border-border bg-surface shrink-0 z-header">
      {/* Left: sidebar toggle + logo + breadcrumb */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <IconButton
          size="base"
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          className="lg:inline-flex"
        >
          {sidebarOpen ? <SidebarClose className="lg:hidden xl:inline" /> : <SidebarOpen />}
          <span className="lg:hidden">
            <Menu />
          </span>
        </IconButton>

        <Link href="/" className="flex items-center gap-2 px-1 focus-ring rounded-sm">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-accent text-accent-fg">
            <span className="text-xs font-bold">W</span>
          </span>
          <span className="hidden sm:inline text-sm font-semibold tracking-tight text-foreground">
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
        className="hidden sm:flex items-center gap-2 h-8 w-[280px] max-w-[40vw] px-3 rounded-md border border-border bg-canvas text-xs text-foreground-tertiary hover:bg-subtle hover:border-border-strong transition-colors focus-ring"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">Search pages, ask AI…</span>
        <Kbd>⌘K</Kbd>
      </button>

      {/* Right: icon actions */}
      <div className="flex items-center gap-1 shrink-0">
        <IconButton
          size="base"
          onClick={toggleCommandPalette}
          aria-label="Search"
          className="sm:hidden"
        >
          <Search />
        </IconButton>

        <IconButton
          size="base"
          onClick={() => openContextPanel('chat')}
          aria-label="Ask your wiki (⌘J)"
          title="Ask your wiki (⌘J)"
        >
          <Sparkles />
        </IconButton>

        <IconButton size="base" onClick={toggleDarkMode} aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
          {darkMode ? <Sun /> : <Moon />}
        </IconButton>

        <IconButton
          size="base"
          onClick={toggleContextPanel}
          aria-label={contextPanelOpen ? 'Close context panel' : 'Open context panel'}
          className={cn(contextPanelOpen && 'bg-subtle text-foreground')}
        >
          {/* Simple panel-right glyph */}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          <span className="sr-only">{isWikiRoute ? 'context' : 'chat'}</span>
        </IconButton>
      </div>
    </header>
  );
}
