'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ChevronDown,
  FileText,
  FileType2,
  Hash,
  History,
  Pin,
  Plus,
  Settings2,
} from 'lucide-react';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { IconButton } from '@/components/ui/icon-button';
import { SectionLabel } from '@/components/ui/panel';
import { Separator } from '@/components/ui/separator';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/cn';
import { Tag } from '@/components/ui/tag';
import { useLintSummary } from '@/hooks/use-lint-summary';
import { useI18n } from '@/components/i18n-provider';

interface PageItem {
  slug: string;
  title: string;
  path: string;
  tags: string[];
  updatedAt: string;
}

interface SourceItem {
  id: string;
  filename: string;
  format?: string;
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
  const { t } = useI18n();
  const pathname = usePathname();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const openSettingsDialog = useUIStore((s) => s.openSettingsDialog);
  const apiFetch = useApiFetch();
  const { id: subjectId } = useCurrentSubject();

  const { data: lintSummary } = useLintSummary(false);
  const criticalCount = lintSummary?.bySeverity.critical ?? 0;
  const isHealthActive = pathname === '/health';
  const isIngestActive = pathname === '/ingest';

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

  const { data: sources = [] } = useQuery({
    queryKey: ['sources', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/sources');
      if (!res.ok) return [] as SourceItem[];
      const body = (await res.json()) as { sources?: SourceItem[] };
      return body.sources ?? [];
    },
    staleTime: 30_000,
    enabled: !!subjectId,
  });

  const visiblePages = useMemo(() => {
    return allPages
      .filter((p) => !isMetaPage(p))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [allPages]);

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

  const totalAll = allPages.filter((p) => !(p.tags ?? []).includes('meta')).length;
  const isActive = (slug: string) => pathname === `/wiki/${slug}`;
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-r border-border-subtle bg-canvas" aria-label={t('nav.wikiNavigation')}>
      {/* Top quick action (primary CTA) — opens the dedicated ingest workspace */}
      <div className="shrink-0 px-3 py-2.5">
        <Link
          href="/ingest"
          onClick={onNavigate}
          className={cn(
            'flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-ring',
            isIngestActive
              ? 'text-accent-fg bg-accent hover:bg-accent'
              : 'bg-accent-subtle text-accent-strong hover:bg-accent/15',
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{t('nav.newIngest')}</span>
        </Link>
      </div>

      <Separator />

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto py-3">
        {metaPages.length > 0 && (
          <div className="px-2 mb-3">
            <SectionLabel className="px-2 py-1 flex items-center gap-1.5">
              <Pin className="h-3 w-3" />
              {t('nav.meta')}
            </SectionLabel>
            <nav aria-label={t('nav.metaPages')}>
              {metaPages.map((page) => (
                <Link
                  key={page.slug}
                  href={`/wiki/${page.slug}`}
                  onClick={onNavigate}
                  className={cn(
                    'relative flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors focus-ring',
                    isActive(page.slug)
                      ? 'bg-surface font-medium text-foreground shadow-xs before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent'
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
            {t('nav.noPages')}
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
                    <span className="flex items-center gap-1.5 uppercase tracking-normal">
                      <ChevronDown
                        className={cn('h-3 w-3 transition-transform', collapsed && '-rotate-90')}
                      />
                      {groupKey === 'Uncategorized' ? t('nav.uncategorized') : formatGroupName(groupKey)}
                    </span>
                    <span className="tabular-nums text-xs font-normal normal-case tracking-normal">
                      {items.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <nav aria-label={t('nav.groupPages', { group: groupKey })} className="mt-0.5">
                      {items.map((page) => (
                        <Link
                          key={page.slug}
                          href={`/wiki/${page.slug}`}
                          onClick={onNavigate}
                          className={cn(
                            'relative flex h-8 items-center gap-2 rounded-md pl-5 pr-2 text-sm transition-colors focus-ring',
                            isActive(page.slug)
                              ? 'bg-surface font-medium text-accent-strong shadow-xs before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent'
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

        {/* Sources — the original documents ingested into this subject */}
        {sources.length > 0 && (
          <div className="px-2 mt-2">
            <button
              type="button"
              onClick={() => setSourcesOpen((o) => !o)}
              aria-expanded={sourcesOpen}
              className="w-full flex items-center justify-between px-2 h-6 rounded-md text-xs font-medium text-foreground-tertiary hover:text-foreground hover:bg-subtle transition-colors focus-ring"
            >
              <span className="flex items-center gap-1.5 uppercase tracking-normal">
                <ChevronDown
                  className={cn('h-3 w-3 transition-transform', !sourcesOpen && '-rotate-90')}
                />
                {t('nav.sources')}
              </span>
              <span className="tabular-nums text-xs font-normal normal-case tracking-normal">
                {sources.length}
              </span>
            </button>
            {sourcesOpen && (
              <nav aria-label={t('nav.ingestedSources')} className="mt-0.5">
                {sources.map((source) => (
                  <Link
                    key={source.id}
                    href={`/sources/${source.id}`}
                    onClick={onNavigate}
                    title={t('nav.openSource', { name: source.filename })}
                    className={cn(
                      'relative flex h-8 items-center gap-2 rounded-md pl-5 pr-2 text-sm transition-colors focus-ring',
                      pathname === `/sources/${source.id}`
                        ? 'bg-surface font-medium text-accent-strong shadow-xs before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent'
                        : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
                    )}
                  >
                    <FileType2 className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
                    <span className="truncate">{source.filename}</span>
                  </Link>
                ))}
              </nav>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 space-y-1 border-t border-border-subtle bg-canvas px-3 py-2.5">
        <Link
          href="/health"
          onClick={onNavigate}
          className={cn(
            'flex items-center justify-between gap-2 h-8 px-2 rounded-md text-sm transition-colors focus-ring',
            isHealthActive
              ? 'bg-subtle text-foreground font-medium'
              : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
          )}
        >
          <span className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-foreground-tertiary" />
            {t('nav.health')}
          </span>
          {criticalCount > 0 && (
            <Tag tone="danger" size="sm">
              {criticalCount}
            </Tag>
          )}
        </Link>
        <Link
          href="/tags"
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2 h-8 px-2 rounded-md text-sm transition-colors focus-ring',
            pathname.startsWith('/tags')
              ? 'bg-subtle text-foreground font-medium'
              : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
          )}
        >
          <Hash className="h-3.5 w-3.5 text-foreground-tertiary" />
          {t('nav.tags')}
        </Link>
        <Link
          href="/history"
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2 h-8 px-2 rounded-md text-sm transition-colors focus-ring',
            pathname.startsWith('/history')
              ? 'bg-subtle text-foreground font-medium'
              : 'text-foreground-secondary hover:bg-subtle hover:text-foreground',
          )}
        >
          <History className="h-3.5 w-3.5 text-foreground-tertiary" />
          {t('nav.history')}
        </Link>
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-foreground-tertiary">
            {t('nav.pageCount', { count: totalAll })}
          </span>
          <IconButton
            size="sm"
            aria-label={t('nav.openSettings')}
            data-tip={t('settings.title')}
            className="tip tip-l"
            onClick={openSettingsDialog}
          >
            <Settings2 />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}
