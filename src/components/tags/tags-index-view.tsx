'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowUpRight, Hash, MoreHorizontal, Search } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import {
  filterTagSummaries,
  sortTagSummaries,
  summarizeTags,
  tagStats,
  type TagSort,
} from '@/lib/tags';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import type { PendingActionView, WikiPage } from '@/lib/contracts';
import { cn } from '@/lib/cn';
import { PendingActionCard } from '@/components/chat/pending-action-card';
import { TagGovernanceDialog } from './tag-governance-dialog';
import { selectActiveTagAction } from './tag-governance-state';
import { useTagSearchParams } from './use-tag-search-params';

type DirectoryScope = 'all' | 'review';

const SCOPE_OPTIONS = [
  { value: 'all' as const, label: 'All' },
  { value: 'review' as const, label: 'Review' },
];

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Stat({ label, value, index }: { label: string; value: number | string; index: number }) {
  return (
    <div className={cn(
      'min-w-0 border-border-subtle',
      index === 0 && 'border-b border-r pb-3 pr-3 sm:border-b-0 sm:pb-0 sm:pl-0 sm:pr-5',
      index === 1 && 'border-b pb-3 pl-3 sm:border-b-0 sm:border-r sm:px-5 sm:pb-0',
      index === 2 && 'border-r pr-3 pt-3 sm:px-5 sm:pt-0',
      index === 3 && 'pl-3 pt-3 sm:pl-5 sm:pr-0 sm:pt-0',
    )}>
      <dt className="truncate text-xs text-foreground-tertiary">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

export function TagsIndexView() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();
  const { searchParams, updateSearchParams } = useTagSearchParams();
  const queryParam = searchParams.get('q') ?? '';
  const sortParam = searchParams.get('sort');
  const scopeParam = searchParams.get('scope');
  const sort: TagSort = sortParam === 'name' || sortParam === 'recent' ? sortParam : 'count';
  const scope: DirectoryScope = scopeParam === 'review' ? 'review' : 'all';
  const [query, setQuery] = useState(queryParam);
  const [governanceTag, setGovernanceTag] = useState<string | null>(null);
  const [localAction, setLocalAction] = useState<PendingActionView | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => setQuery(queryParam), [queryParam]);
  useEffect(() => {
    setGovernanceTag(null);
    setLocalAction(null);
    setActionError(null);
  }, [subjectId]);

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
  const { data: serverActions = [] } = useQuery({
    queryKey: ['tag-actions', subjectId],
    queryFn: async () => {
      const response = await apiFetch('/api/tag-actions');
      if (!response.ok) return [] as PendingActionView[];
      const data = await response.json() as { actions?: PendingActionView[] };
      return data.actions ?? [];
    },
    enabled: !!subjectId,
    staleTime: 5_000,
  });

  const summaries = useMemo(() => summarizeTags(pages), [pages]);
  const stats = useMemo(() => tagStats(pages, summaries), [pages, summaries]);
  const reviewTags = useMemo(() => {
    const tags = new Set(summaries.filter((item) => item.count === 1).map((item) => item.tag));
    for (const group of stats.duplicateGroups) {
      for (const tag of group) tags.add(tag);
    }
    return tags;
  }, [stats.duplicateGroups, summaries]);
  const visibleTags = useMemo(() => {
    const scoped = scope === 'review'
      ? summaries.filter((summary) => reviewTags.has(summary.tag))
      : summaries;
    return sortTagSummaries(filterTagSummaries(scoped, query), sort);
  }, [query, reviewTags, scope, sort, summaries]);
  const currentAction = localAction ?? selectActiveTagAction(serverActions);
  const actionInProgress = Boolean(
    currentAction && ['pending', 'approved', 'executing'].includes(currentAction.status),
  );

  function updateQuery(value: string) {
    setQuery(value);
    updateSearchParams({ q: value || null });
  }

  async function consumeAction(actionId: string, decision: 'approve' | 'reject') {
    if (!subjectId) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const response = await apiFetch(`/api/pending-actions/${actionId}/${decision}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      const data = await response.json() as { action?: PendingActionView; error?: string };
      if (data.action) setLocalAction(data.action);
      if (!response.ok) {
        setActionError(data.error ?? 'The tag action could not be updated.');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['tag-actions', subjectId] });
      if (decision === 'approve' && data.action?.status === 'applied') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['pages'] }),
          queryClient.invalidateQueries({ queryKey: ['history'] }),
          queryClient.invalidateQueries({ queryKey: ['search'] }),
          queryClient.invalidateQueries({ queryKey: ['graph'] }),
        ]);
        router.refresh();
      }
    } catch {
      setActionError('The tag action could not be updated.');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-7 px-5 py-8 sm:px-8 sm:py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Hash className="h-5 w-5 text-foreground-tertiary" aria-hidden />
            Tags
          </h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            Tag coverage for <span className="font-mono text-foreground">{subjectSlug || 'current subject'}</span>
          </p>
        </div>
        {stats.pageCount > 0 && (
          <p className="text-xs tabular-nums text-foreground-tertiary">
            {stats.taggedPageCount}/{stats.pageCount} pages tagged
          </p>
        )}
      </header>

      {!isLoading && !isError && summaries.length > 0 && (
        <dl className="grid grid-cols-2 border-y border-border-subtle py-3 sm:grid-cols-4">
          <Stat label="Tags" value={stats.tagCount} index={0} />
          <Stat label="Pages" value={stats.pageCount} index={1} />
          <Stat label="Single-use" value={stats.singletonCount} index={2} />
          <Stat label="Format variants" value={stats.duplicateGroups.length} index={3} />
        </dl>
      )}

      {currentAction && (
        <section aria-label="Tag action approval" className="space-y-2">
          <PendingActionCard
            action={currentAction}
            busy={actionBusy}
            onApprove={(actionId) => void consumeAction(actionId, 'approve')}
            onReject={(actionId) => void consumeAction(actionId, 'reject')}
          />
          {actionError && <p role="alert" className="text-xs text-danger">{actionError}</p>}
          {['applied', 'rejected', 'expired', 'failed'].includes(currentAction.status) && (
            <Button
              intent="ghost"
              size="sm"
              onClick={() => {
                setLocalAction(null);
                setActionError(null);
              }}
            >
              Dismiss
            </Button>
          )}
        </section>
      )}

      <div className="sticky top-0 z-10 -mx-2 flex flex-col gap-3 border-y border-border-subtle bg-canvas/95 px-2 py-3 backdrop-blur sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search tags or pages</span>
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-foreground-tertiary" aria-hidden />
          <Input
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="Search tags or pages…"
            className="pl-8"
          />
        </label>
        <div className="flex items-center justify-between gap-2 sm:justify-start">
          <Segmented
            value={scope}
            options={SCOPE_OPTIONS}
            onChange={(value) => updateSearchParams({ scope: value === 'all' ? null : value })}
            aria-label="Tag directory scope"
          />
          <Select
            value={sort}
            onChange={(event) => updateSearchParams({
              sort: event.target.value === 'count' ? null : event.target.value,
            })}
            aria-label="Sort tags"
            className="h-8"
          >
            <option value="count">Most used</option>
            <option value="name">Name</option>
            <option value="recent">Recently updated</option>
          </Select>
        </div>
      </div>

      {!subjectId || isLoading ? (
        <div className="divide-y divide-border-subtle border-y border-border-subtle">
          {[1, 2, 3, 4, 5].map((item) => (
            <div key={item} className="h-16 animate-pulse bg-subtle/60" />
          ))}
        </div>
      ) : isError ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
          <AlertTriangle className="h-5 w-5 text-warning" aria-hidden />
          <p className="text-sm text-foreground-secondary">Tags could not be loaded.</p>
          <Button intent="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
        </div>
      ) : summaries.length === 0 ? (
        <p className="py-10 text-center text-sm italic text-foreground-tertiary">No tags yet.</p>
      ) : visibleTags.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-foreground-secondary">No tags match this view.</p>
          {(query || scope === 'review') && (
            <Button
              intent="ghost"
              size="sm"
              className="mt-2"
              onClick={() => {
                setQuery('');
                updateSearchParams({ q: null, scope: null });
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <section aria-labelledby="tag-directory-heading">
          <div className="grid grid-cols-[minmax(0,1fr)_4rem_2rem] gap-3 border-b border-border-subtle px-2 pb-2 text-xs text-foreground-tertiary sm:grid-cols-[minmax(0,1fr)_5rem_5rem_6rem_2rem]">
            <h2 id="tag-directory-heading" className="font-normal">Tag</h2>
            <span className="text-right">Pages</span>
            <span className="hidden text-right sm:block">Coverage</span>
            <span className="hidden text-right sm:block">Updated</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul className="divide-y divide-border-subtle border-b border-border-subtle">
            {visibleTags.map((summary) => {
              const href = `/tags/${encodeURIComponent(summary.tag)}${subjectSlug ? `?s=${encodeURIComponent(subjectSlug)}` : ''}`;
              return (
                <li key={summary.tag} className="group grid min-h-16 grid-cols-[minmax(0,1fr)_4rem_2rem] items-center gap-3 px-2 py-2.5 transition-colors hover:bg-subtle sm:grid-cols-[minmax(0,1fr)_5rem_5rem_6rem_2rem]">
                  <div className="min-w-0">
                    <Link
                      href={href}
                      className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-foreground transition-colors group-hover:text-accent-strong focus-ring"
                    >
                      <span className="text-foreground-tertiary">#</span>
                      <span className="truncate">{summary.tag}</span>
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
                    </Link>
                    <p className="mt-1 truncate text-xs text-foreground-tertiary">
                      {summary.pages.slice(0, 3).map((page) => page.title).join(' · ')}
                    </p>
                  </div>
                  <span className="text-right text-sm tabular-nums text-foreground-secondary">{summary.count}</span>
                  <span className="hidden text-right text-xs tabular-nums text-foreground-tertiary sm:block">
                    {Math.round(summary.coverage * 100)}%
                  </span>
                  <time className="hidden text-right text-xs tabular-nums text-foreground-tertiary sm:block" dateTime={summary.updatedAt ?? undefined}>
                    {formatDate(summary.updatedAt)}
                  </time>
                  <IconButton
                    size="sm"
                    disabled={actionInProgress}
                    onClick={() => setGovernanceTag(summary.tag)}
                    aria-label={`Manage ${summary.tag}`}
                    title={actionInProgress ? 'Resolve the current tag action first' : `Manage ${summary.tag}`}
                  >
                    <MoreHorizontal aria-hidden />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs tabular-nums text-foreground-tertiary">
            {visibleTags.length} of {scope === 'review' ? reviewTags.size : summaries.length} tags
          </p>
        </section>
      )}

      {governanceTag && subjectId && (
        <TagGovernanceDialog
          sourceTag={governanceTag}
          suggestedTarget={stats.duplicateGroups
            .find((group) => group.includes(governanceTag))
            ?.find((tag) => tag !== governanceTag)}
          existingTags={summaries.map((summary) => summary.tag)}
          subjectId={subjectId}
          onClose={() => setGovernanceTag(null)}
          onCreated={(action) => {
            setLocalAction(action);
            setActionError(null);
            void queryClient.invalidateQueries({ queryKey: ['tag-actions', subjectId] });
          }}
        />
      )}
    </div>
  );
}
