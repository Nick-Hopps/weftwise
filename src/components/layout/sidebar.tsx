'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  FileText,
  Pin,
  Plus,
  Search,
  Settings2,
} from 'lucide-react';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { SectionLabel } from '@/components/ui/panel';
import { Separator } from '@/components/ui/separator';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/cn';

interface PageItem {
  slug: string;
  title: string;
  path: string;
  tags: string[];
  updatedAt: string;
}

function isMetaPage(page: PageItem): boolean {
  return (page.tags ?? []).includes('meta');
}

function sortMetaPages(pages: PageItem[]): PageItem[] {
  return [...pages].sort((a, b) => {
    const aIsIndex = /(^|\/)index$/.test(a.slug);
    const bIsIndex = /(^|\/)index$/.test(b.slug);
    if (aIsIndex !== bIsIndex) return aIsIndex ? -1 : 1;
    const aIsLog = /(^|\/)log$/.test(a.slug);
    const bIsLog = /(^|\/)log$/.test(b.slug);
    if (aIsLog !== bIsLog) return aIsLog ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

function groupKeyFor(page: PageItem): string {
  const path = page.path ?? '';
  if (path.includes('/')) return path.split('/')[0];
  const slug = page.slug ?? '';
  if (slug.includes('/')) return slug.split('/')[0];
  return 'Uncategorized';
}

function formatGroupName(raw: string): string {
  if (!raw) return 'Uncategorized';
  return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps = {}) {
  const pathname = usePathname();
  const [filter, setFilter] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const openSettingsDialog = useUIStore((s) => s.openSettingsDialog);
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  const { data: allPages = [], isLoading } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) return [] as PageItem[];
      return (await res.json()) as PageItem[];
    },
    staleTime: 30_000,
    enabled: !!subjectId,
  });

  const visiblePages = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return allPages
      .filter((p) => !isMetaPage(p))
      .filter((p) => (q ? p.title.toLowerCase().includes(q) : true))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [allPages, filter]);

  const metaPages = useMemo(
    () => sortMetaPages(allPages.filter(isMetaPage)),
    [allPages],
  );

  const groups = useMemo(() => {
    const map = new Map<string, PageItem[]>();
    for (const page of visiblePages) {
      const key = groupKeyFor(page);
      const arr = map.get(key) ?? [];
      arr.push(page);
      map.set(key, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visiblePages]);

  const totalVisible = visiblePages.length;
  const totalAll = allPages.filter((p) => !(p.tags ?? []).includes('meta')).length;
  const isActive = (slug: string) => pathname === `/wiki/${slug}`;
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="flex flex-col h-full w-full bg-canvas border-r border-border overflow-hidden">
      {/* Top quick action (primary CTA) */}
      <div className="px-2 py-2 shrink-0">
        <Link
          href="/"
          onClick={onNavigate}
          className="flex items-center gap-2 h-8 px-2.5 rounded-md text-sm font-medium text-accent bg-accent/8 hover:bg-accent/12 transition-colors focus-ring"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New Ingest</span>
        </Link>
      </div>

      {/* Filter */}
      <div className="px-2 pb-2 shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-foreground-tertiary pointer-events-none" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter pages…"
            aria-label="Filter pages"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      <Separator />

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto py-2">
        {metaPages.length > 0 && (
          <div className="px-2 mb-3">
            <SectionLabel className="px-2 py-1 flex items-center gap-1.5">
              <Pin className="h-3 w-3" />
              Meta
            </SectionLabel>
            <nav aria-label="Meta pages">
              {metaPages.map((page) => (
                <Link
                  key={page.slug}
                  href={`/wiki/${page.slug}`}
                  onClick={onNavigate}
                  className={cn(
                    'flex items-center gap-2 h-8 px-2 rounded-md text-sm transition-colors focus-ring',
                    isActive(page.slug)
                      ? 'bg-subtle text-foreground font-medium'
                      : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
                  <span className="truncate">{page.title}</span>
                </Link>
              ))}
            </nav>
          </div>
        )}

        {isLoading ? (
          <div className="px-3 py-3 space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-4 rounded bg-subtle animate-pulse" />
            ))}
          </div>
        ) : totalAll === 0 ? (
          <p className="px-4 py-6 text-xs text-foreground-tertiary italic text-center">
            No pages yet. Ingest a source to get started.
          </p>
        ) : totalVisible === 0 ? (
          <p className="px-4 py-6 text-xs text-foreground-tertiary italic text-center">
            No pages match &ldquo;{filter}&rdquo;.
          </p>
        ) : (
          <div className="px-2 space-y-2">
            {groups.map(([groupKey, items]) => {
              const collapsed = collapsedGroups[groupKey] === true;
              return (
                <div key={groupKey}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(groupKey)}
                    aria-expanded={!collapsed}
                    className="w-full flex items-center justify-between px-2 h-6 rounded-md text-xs font-medium text-foreground-tertiary hover:text-foreground hover:bg-subtle transition-colors focus-ring"
                  >
                    <span className="flex items-center gap-1.5 uppercase tracking-wider">
                      <ChevronDown
                        className={cn('h-3 w-3 transition-transform', collapsed && '-rotate-90')}
                      />
                      {formatGroupName(groupKey)}
                    </span>
                    <span className="tabular-nums text-xs font-normal normal-case tracking-normal">
                      {items.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <nav aria-label={`${groupKey} pages`} className="mt-0.5">
                      {items.map((page) => (
                        <Link
                          key={page.slug}
                          href={`/wiki/${page.slug}`}
                          onClick={onNavigate}
                          className={cn(
                            'flex items-center gap-2 h-8 pl-5 pr-2 rounded-md text-sm transition-colors focus-ring',
                            isActive(page.slug)
                              ? 'bg-accent-subtle text-accent-strong font-medium'
                              : 'text-foreground hover:bg-subtle',
                          )}
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
                          <span className="truncate">{page.title}</span>
                        </Link>
                      ))}
                    </nav>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border px-2 py-2 flex items-center justify-between">
        <span className="text-xs text-foreground-tertiary px-1">
          {totalAll} {totalAll === 1 ? 'page' : 'pages'}
        </span>
        <IconButton
          size="sm"
          aria-label="Open settings"
          title="Settings"
          onClick={openSettingsDialog}
        >
          <Settings2 />
        </IconButton>
      </div>
    </div>
  );
}
