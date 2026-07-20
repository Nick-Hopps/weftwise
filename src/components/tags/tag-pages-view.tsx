'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, ArrowUpRight, Hash, Plus, Search, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import {
  filterPagesByTags,
  relatedTags,
  type TagMatchMode,
} from '@/lib/tags';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Tag } from '@/components/ui/tag';
import type { WikiPage } from '@/lib/contracts';
import { useTagSearchParams } from './use-tag-search-params';
import { useI18n } from '@/components/i18n-provider';

type PageSort = 'recent' | 'title';

export function TagPagesView({ tag }: { tag: string }) {
  const { t, formatDate } = useI18n();
  const apiFetch = useApiFetch();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();
  const { searchParams, updateSearchParams } = useTagSearchParams();
  const queryParam = searchParams.get('q') ?? '';
  const mode: TagMatchMode = searchParams.get('mode') === 'or' ? 'or' : 'and';
  const sort: PageSort = searchParams.get('sort') === 'title' ? 'title' : 'recent';
  const extraTags = useMemo(
    () => [...new Set(searchParams.getAll('with').filter((item) => item && item !== tag))],
    [searchParams, tag],
  );
  const selectedTags = useMemo(() => [tag, ...extraTags], [extraTags, tag]);
  const [query, setQuery] = useState(queryParam);
  const modeOptions = [
    { value: 'and' as const, label: t('tags.matchAll') },
    { value: 'or' as const, label: t('tags.matchAny') },
  ];

  useEffect(() => setQuery(queryParam), [queryParam]);

  const {
    data: pages = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) throw new Error('Failed to load pages');
      return (await res.json()) as WikiPage[];
    },
    enabled: !!subjectId,
    staleTime: 30_000,
  });

  const matched = useMemo(
    () => filterPagesByTags(pages, selectedTags, mode, query, sort),
    [mode, pages, query, selectedTags, sort],
  );
  const related = useMemo(
    () => relatedTags(pages, selectedTags, mode).slice(0, 12),
    [mode, pages, selectedTags],
  );

  function updateQuery(value: string) {
    setQuery(value);
    updateSearchParams({ q: value || null });
  }

  function addTag(nextTag: string) {
    updateSearchParams({ with: [...extraTags, nextTag] });
  }

  function removeTag(removedTag: string) {
    updateSearchParams({ with: extraTags.filter((item) => item !== removedTag) });
  }

  const allTagsHref = `/tags${subjectSlug ? `?s=${encodeURIComponent(subjectSlug)}` : ''}`;

  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-7 px-5 py-8 sm:px-8 sm:py-10">
      <header className="space-y-4">
        <Link
          href={allTagsHref}
          className="inline-flex items-center gap-1.5 text-xs text-foreground-tertiary transition-colors hover:text-foreground focus-ring"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('tags.allTags')}
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="flex min-w-0 items-center gap-2 text-xl font-semibold text-foreground">
              <Hash className="h-5 w-5 shrink-0 text-foreground-tertiary" aria-hidden />
              <span className="truncate">{tag}</span>
            </h1>
            <p className="mt-1 text-sm text-foreground-secondary">
              {isLoading
                ? t('tags.loadingPages')
                : t(matched.length === 1 ? 'tags.matchingPage.one' : 'tags.matchingPage.many', {
                    count: matched.length,
                  })}
            </p>
          </div>
          {extraTags.length > 0 && (
            <Segmented
              value={mode}
              options={modeOptions}
              onChange={(value) => updateSearchParams({ mode: value === 'and' ? null : value })}
              aria-label={t('tags.matchMode')}
            />
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-y border-border-subtle py-3">
        <Tag tone="accent" size="base">{tag}</Tag>
        {extraTags.map((extraTag) => (
          <span key={extraTag} className="inline-flex h-6 items-center gap-1 rounded-sm bg-subtle pl-2 pr-1 text-xs font-medium text-foreground-secondary">
            {extraTag}
            <button
              type="button"
              onClick={() => removeTag(extraTag)}
              className="rounded-sm p-0.5 transition-colors hover:bg-border hover:text-foreground focus-ring"
              aria-label={t('tags.removeFilter', { tag: extraTag })}
              title={t('tags.removeTag', { tag: extraTag })}
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        {extraTags.length > 0 && (
          <Button
            intent="ghost"
            size="sm"
            onClick={() => updateSearchParams({ with: null, mode: null })}
          >
            {t('tags.clearCombined')}
          </Button>
        )}
      </div>

      <div className="sticky top-0 z-10 -mx-2 flex flex-col gap-3 border-y border-border-subtle bg-canvas/95 px-2 py-3 backdrop-blur sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('tags.searchMatching')}</span>
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-foreground-tertiary" aria-hidden />
          <Input
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder={t('tags.searchMatchingPlaceholder')}
            className="pl-8"
          />
        </label>
        <Select
          value={sort}
          onChange={(event) => updateSearchParams({
            sort: event.target.value === 'recent' ? null : event.target.value,
          })}
          aria-label={t('tags.sortMatching')}
          className="h-8 self-end sm:self-auto"
        >
          <option value="recent">{t('tags.recent')}</option>
          <option value="title">{t('tags.titleSort')}</option>
        </Select>
      </div>

      {!subjectId || isLoading ? (
        <div className="divide-y divide-border-subtle border-y border-border-subtle">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className="h-24 animate-pulse bg-subtle/60" />
          ))}
        </div>
      ) : isError ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
          <AlertTriangle className="h-5 w-5 text-warning" aria-hidden />
          <p className="text-sm text-foreground-secondary">{t('tags.pagesLoadError')}</p>
          <Button intent="outline" size="sm" onClick={() => void refetch()}>{t('tags.retry')}</Button>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_14rem]">
          <section aria-labelledby="matching-pages-heading" className="min-w-0">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="matching-pages-heading" className="text-xs font-medium uppercase tracking-wider text-foreground-tertiary">
                {t('tags.matchingPages')}
              </h2>
              <span className="text-xs tabular-nums text-foreground-tertiary">{matched.length}</span>
            </div>
            {matched.length === 0 ? (
              <div className="border-y border-border-subtle py-10 text-center">
                <p className="text-sm text-foreground-secondary">{t('tags.noPagesMatch')}</p>
                {(query || extraTags.length > 0) && (
                  <Button
                    intent="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      setQuery('');
                      updateSearchParams({ q: null, with: null, mode: null });
                    }}
                  >
                    {t('tags.clearFilters')}
                  </Button>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle border-y border-border-subtle">
                {matched.map((page) => {
                  const otherTags = (page.tags ?? []).filter((pageTag) => !selectedTags.includes(pageTag) && pageTag !== 'meta');
                  return (
                    <li key={`${page.subjectId}:${page.slug}`} className="group px-2 py-3 transition-colors hover:bg-subtle">
                      <div className="flex items-start gap-3">
                        <ArrowUpRight className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground-tertiary transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                            <Link
                              href={`/wiki/${page.slug}?s=${encodeURIComponent(subjectSlug)}`}
                              className="truncate text-sm font-medium text-foreground transition-colors group-hover:text-accent-strong focus-ring"
                            >
                              {page.title}
                            </Link>
                            <time className="shrink-0 text-xs tabular-nums text-foreground-tertiary" dateTime={page.updatedAt}>
                              {formatDate(page.updatedAt, { year: 'numeric', month: 'short', day: 'numeric' })}
                            </time>
                          </div>
                          {page.summary && (
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-foreground-secondary">{page.summary}</p>
                          )}
                          {otherTags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {otherTags.slice(0, 4).map((pageTag) => (
                                <Link
                                  key={pageTag}
                                  href={`/tags/${encodeURIComponent(pageTag)}?s=${encodeURIComponent(subjectSlug)}`}
                                  className="focus-ring"
                                >
                                  <Tag>{pageTag}</Tag>
                                </Link>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <aside aria-labelledby="related-tags-heading" className="min-w-0 lg:border-l lg:border-border-subtle lg:pl-5">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="related-tags-heading" className="text-xs font-medium uppercase tracking-wider text-foreground-tertiary">
                {t('tags.relatedTags')}
              </h2>
              <span className="text-xs tabular-nums text-foreground-tertiary">{related.length}</span>
            </div>
            {related.length === 0 ? (
              <p className="border-t border-border-subtle py-3 text-xs italic text-foreground-tertiary">{t('tags.noRelated')}</p>
            ) : (
              <ul className="divide-y divide-border-subtle border-y border-border-subtle">
                {related.map((item) => (
                  <li key={item.tag}>
                    <button
                      type="button"
                      onClick={() => addTag(item.tag)}
                      className="group/related flex w-full min-w-0 items-center gap-2 px-1 py-2 text-left transition-colors hover:bg-subtle focus-ring"
                      title={t('tags.addFilter', { tag: item.tag })}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary group-hover/related:text-accent" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground-secondary group-hover/related:text-foreground">{item.tag}</span>
                      <span className="shrink-0 text-xs tabular-nums text-foreground-tertiary">{item.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
