'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowUpRight, Hash, MoreHorizontal, Search } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import {
  buildTagReviewQueue,
  filterTagReviewQueue,
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
import {
  WorkspaceMetric,
  WorkspacePage,
  WorkspacePageHeader,
  WorkspaceState,
  WorkspaceSummary,
  WorkspaceToolbar,
} from '@/components/ui/workspace-page';
import type { PendingActionView, WikiPage } from '@/lib/contracts';
import { PendingActionCard } from '@/components/chat/pending-action-card';
import { TagGovernanceDialog } from './tag-governance-dialog';
import { selectActiveTagAction } from './tag-governance-state';
import { TagReviewQueueView } from './tag-review-queue';
import { useTagSearchParams } from './use-tag-search-params';

type DirectoryScope = 'all' | 'review';

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  const [governanceIntent, setGovernanceIntent] = useState<{
    sourceTag: string;
    suggestedTarget?: string;
  } | null>(null);
  const [localAction, setLocalAction] = useState<PendingActionView | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => setQuery(queryParam), [queryParam]);
  useEffect(() => {
    setGovernanceIntent(null);
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
  const reviewQueue = useMemo(() => buildTagReviewQueue(pages, summaries), [pages, summaries]);
  const visibleReviewQueue = useMemo(
    () => filterTagReviewQueue(reviewQueue, query),
    [query, reviewQueue],
  );
  const visibleTags = useMemo(() => {
    return sortTagSummaries(filterTagSummaries(summaries, query), sort);
  }, [query, sort, summaries]);
  const scopeOptions = useMemo(() => [
    { value: 'all' as const, label: 'All' },
    { value: 'review' as const, label: `Review ${reviewQueue.issueCount}` },
  ], [reviewQueue.issueCount]);
  const recommendedTargetBySource = useMemo(() => {
    const targets = new Map<string, string>();
    for (const group of reviewQueue.variantGroups) {
      for (const variant of group.variants) targets.set(variant.tag, group.canonical.tag);
    }
    return targets;
  }, [reviewQueue.variantGroups]);
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
    <WorkspacePage>
      <WorkspacePageHeader
        icon={<Hash className="h-5 w-5 text-foreground-tertiary" aria-hidden />}
        title="Tags"
        description={<>Tag coverage for <span className="text-foreground">{subjectSlug || 'current subject'}</span></>}
        meta={stats.pageCount > 0 ? `${stats.taggedPageCount}/${stats.pageCount} pages tagged` : undefined}
      />

      {!isLoading && !isError && summaries.length > 0 && (
        <WorkspaceSummary aria-label="Tag summary" className="grid-cols-2 sm:grid-cols-4">
          <WorkspaceMetric label="Tags" value={stats.tagCount} className="border-b border-r border-border-subtle sm:border-b-0" />
          <WorkspaceMetric label="Pages" value={stats.pageCount} className="border-b border-border-subtle sm:border-b-0 sm:border-r" />
          <WorkspaceMetric label="Single-use" value={stats.singletonCount} className="border-r border-border-subtle" />
          <WorkspaceMetric label="Format variants" value={stats.duplicateGroups.length} />
        </WorkspaceSummary>
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

      <WorkspaceToolbar aria-label="Tag directory controls" className="flex flex-col gap-3 sm:flex-row sm:items-center">
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
            options={scopeOptions}
            onChange={(value) => updateSearchParams({ scope: value === 'all' ? null : value })}
            aria-label="Tag directory scope"
          />
          {scope === 'all' && (
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
          )}
        </div>
      </WorkspaceToolbar>

      {!subjectId || isLoading ? (
        <div className="divide-y divide-border-subtle border-y border-border-subtle">
          {[1, 2, 3, 4, 5].map((item) => (
            <div key={item} className="h-16 animate-pulse bg-subtle/60" />
          ))}
        </div>
      ) : isError ? (
        <WorkspaceState
          role="alert"
          icon={<AlertTriangle className="h-5 w-5 text-warning" aria-hidden />}
          title="Tags could not be loaded"
          description="Retry the request without changing the current filters."
          action={<Button intent="outline" size="sm" onClick={() => void refetch()}>Retry</Button>}
        />
      ) : scope === 'review' && visibleReviewQueue.issueCount === 0 && reviewQueue.issueCount > 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-foreground-secondary">No review items match this search.</p>
          <Button
            intent="ghost"
            size="sm"
            className="mt-2"
            onClick={() => updateQuery('')}
          >
            Clear search
          </Button>
        </div>
      ) : scope === 'review' ? (
        <TagReviewQueueView
          queue={visibleReviewQueue}
          subjectSlug={subjectSlug}
          actionDisabled={actionInProgress}
          onManageTag={(sourceTag, suggestedTarget) => setGovernanceIntent({
            sourceTag,
            ...(suggestedTarget ? { suggestedTarget } : {}),
          })}
        />
      ) : summaries.length === 0 ? (
        <WorkspaceState
          icon={<Hash className="h-5 w-5 text-foreground-tertiary" aria-hidden />}
          title="No tags yet"
          description="Tags added to pages in this subject will appear here."
        />
      ) : visibleTags.length === 0 ? (
        <WorkspaceState
          title="No tags match this view"
          description="Adjust the search or clear the active filters."
          action={query ? (
            <Button
              intent="ghost"
              size="sm"
              onClick={() => {
                setQuery('');
                updateSearchParams({ q: null });
              }}
            >
              Clear filters
            </Button>
          ) : undefined}
        />
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
                    onClick={() => setGovernanceIntent({
                      sourceTag: summary.tag,
                      ...(recommendedTargetBySource.get(summary.tag)
                        ? { suggestedTarget: recommendedTargetBySource.get(summary.tag) }
                        : {}),
                    })}
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
            {visibleTags.length} of {summaries.length} tags
          </p>
        </section>
      )}

      {governanceIntent && subjectId && (
        <TagGovernanceDialog
          sourceTag={governanceIntent.sourceTag}
          suggestedTarget={governanceIntent.suggestedTarget}
          existingTags={summaries.map((summary) => summary.tag)}
          subjectId={subjectId}
          onClose={() => setGovernanceIntent(null)}
          onCreated={(action) => {
            setLocalAction(action);
            setActionError(null);
            void queryClient.invalidateQueries({ queryKey: ['tag-actions', subjectId] });
          }}
        />
      )}
    </WorkspacePage>
  );
}
