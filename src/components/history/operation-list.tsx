'use client';

import { useState } from 'react';
import { ChevronDown, History as HistoryIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { cn } from '@/lib/cn';
import { Tag } from '@/components/ui/tag';
import {
  WorkspaceMetric,
  WorkspacePage,
  WorkspacePageHeader,
  WorkspaceState,
  WorkspaceSummary,
} from '@/components/ui/workspace-page';
import type { HistoryEntry } from '@/lib/contracts';
import { OperationDiff } from './operation-diff';
import { RevertButton } from './revert-button';
import { useI18n } from '@/components/i18n-provider';
import type { TranslationFunction } from '@/lib/i18n/translator';

function operationTypeLabel(type: string, t: TranslationFunction): string {
  const keys = {
    ingest: 'history.type.ingest',
    'save-to-wiki': 'history.type.save',
    curate: 'history.type.curate',
    merge: 'history.type.merge',
    split: 'history.type.split',
    edit: 'history.type.edit',
    delete: 'history.type.delete',
  } as const;
  return type in keys ? t(keys[type as keyof typeof keys]) : type;
}

function entrySummary(entry: HistoryEntry, t: TranslationFunction) {
  const shown = entry.affectedPages.slice(0, 5);
  const extra = entry.affectedPages.length - shown.length;
  return `${shown.map((page) => page.slug).join(', ') || t('history.noPageChanges')}${extra > 0 ? ` +${extra}` : ''}`;
}

/** 窄屏使用行内详情，保持单手滚动上下文。 */
function MobileRow({ entry }: { entry: HistoryEntry }) {
  const { t, formatDate } = useI18n();
  const [open, setOpen] = useState(false);
  const typeLabel = operationTypeLabel(entry.type, t);
  const when = entry.date ? formatDate(entry.date, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 py-3 text-left transition-colors hover:bg-subtle"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <Tag tone={entry.status === 'reverted' ? 'neutral' : 'accent'} size="sm">
              {typeLabel}
            </Tag>
            {entry.status === 'reverted' && (
              <span className="text-xs text-foreground-tertiary">{t('history.reverted')}</span>
            )}
          </span>
          <span className="mt-1.5 block truncate text-sm text-foreground">{entrySummary(entry, t)}</span>
          <span className="mt-1 block text-xs tabular-nums text-foreground-tertiary">
            {when}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-foreground-tertiary transition-transform duration-base',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div className="space-y-4 border-t border-border-subtle bg-canvas/60 px-2 py-4">
          <OperationDiff operationId={entry.id} />
          <RevertButton entry={entry} />
        </div>
      )}
    </li>
  );
}

function ListItem({
  entry,
  selected,
  onSelect,
}: {
  entry: HistoryEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t, formatDate } = useI18n();
  const typeLabel = operationTypeLabel(entry.type, t);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        className={cn(
          'w-full border-l-2 px-4 py-3 text-left transition-colors',
          selected
            ? 'border-accent bg-accent-subtle'
            : 'border-transparent hover:bg-subtle',
        )}
      >
        <span className="flex items-center gap-2">
          <Tag tone={entry.status === 'reverted' ? 'neutral' : 'accent'} size="sm">
            {typeLabel}
          </Tag>
          {entry.status === 'reverted' && (
            <span className="text-xs text-foreground-tertiary">{t('history.reverted')}</span>
          )}
          <span className="ml-auto shrink-0 text-xs tabular-nums text-foreground-tertiary">
            {entry.date ? formatDate(entry.date, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
          </span>
        </span>
        <span className="mt-1.5 block truncate text-sm font-medium text-foreground">
          {entrySummary(entry, t)}
        </span>
        <span className="mt-1 block truncate text-xs text-foreground-tertiary">
          {entry.message}
        </span>
      </button>
    </li>
  );
}

function DetailPane({ entry }: { entry: HistoryEntry }) {
  const { t, formatDate } = useI18n();
  const typeLabel = operationTypeLabel(entry.type, t);

  return (
    <div className="space-y-5">
      <header className="border-b border-border-subtle pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone={entry.status === 'reverted' ? 'neutral' : 'accent'} size="sm">
                {typeLabel}
              </Tag>
              {entry.status === 'reverted' && (
                <span className="text-xs text-foreground-tertiary">{t('history.reverted')}</span>
              )}
              <time className="text-xs tabular-nums text-foreground-tertiary" dateTime={entry.date ?? undefined}>
                {entry.date ? formatDate(entry.date, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
              </time>
            </div>
            <h2 className="mt-3 text-sm font-semibold text-foreground">{t('history.changeDetails')}</h2>
            <p className="mt-1 break-words text-sm leading-5 text-foreground-secondary">
              {entry.message}
            </p>
          </div>
          <div className="shrink-0"><RevertButton entry={entry} /></div>
        </div>
        {entry.affectedPages.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {entry.affectedPages.map((page) => (
              <span
                key={`${page.action}:${page.slug}`}
                className="rounded-sm bg-subtle px-2 py-1 text-xs text-foreground-secondary"
              >
                {page.slug}
              </span>
            ))}
          </div>
        )}
      </header>
      <OperationDiff operationId={entry.id} />
    </div>
  );
}

export function OperationList() {
  const { t, formatDate } = useI18n();
  const apiFetch = useApiFetch();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['history', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/history');
      if (!res.ok) return [] as HistoryEntry[];
      return (await res.json()) as HistoryEntry[];
    },
    enabled: !!subjectId,
    staleTime: 10_000,
  });

  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null;
  const revertedCount = entries.filter((entry) => entry.status === 'reverted').length;

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        icon={<HistoryIcon className="h-5 w-5 text-foreground-tertiary" aria-hidden />}
        title={t('history.title')}
        description={t('history.description', { subject: subjectSlug || t('history.currentSubject') })}
        meta={!isLoading ? t('history.operationCount', { count: entries.length }) : undefined}
      />

      {!isLoading && entries.length > 0 && (
        <WorkspaceSummary aria-label={t('history.summary')} className="grid-cols-2 sm:grid-cols-3">
          <WorkspaceMetric
            label={t('history.operations')}
            value={entries.length}
            className="border-b border-r border-border-subtle sm:border-b-0"
          />
          <WorkspaceMetric
            label={t('history.reverted')}
            value={revertedCount}
            className="border-b border-border-subtle sm:border-b-0 sm:border-r"
          />
          <WorkspaceMetric
            label={t('history.latestChange')}
            value={entries[0]?.date ? formatDate(entries[0].date, { month: 'short', day: 'numeric' }) : '—'}
            className="col-span-2 sm:col-span-1"
          />
        </WorkspaceSummary>
      )}

      {!subjectId || isLoading ? (
        <div className="divide-y divide-border-subtle border-y border-border-subtle">
          {[1, 2, 3, 4, 5].map((item) => (
            <div key={item} className="h-[72px] animate-pulse bg-subtle/60" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <WorkspaceState
          icon={<HistoryIcon className="h-5 w-5 text-foreground-tertiary" aria-hidden />}
          title={t('history.empty.title')}
          description={t('history.empty.description')}
        />
      ) : (
        <>
          <ul className="divide-y divide-border-subtle border-y border-border-subtle md:hidden">
            {entries.map((entry) => <MobileRow key={entry.id} entry={entry} />)}
          </ul>

          <div className="hidden border-y border-border-subtle md:grid md:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="min-h-0 overflow-y-auto border-r border-border-subtle" aria-label={t('history.operations')}>
              <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-border-subtle bg-surface/95 px-4 py-3 backdrop-blur-sm">
                <h2 className="text-xs font-semibold text-foreground-secondary">{t('history.operations')}</h2>
                <span className="text-xs tabular-nums text-foreground-tertiary">{t('history.newestFirst')}</span>
              </div>
              <ul className="divide-y divide-border-subtle">
                {entries.map((entry) => (
                  <ListItem
                    key={entry.id}
                    entry={entry}
                    selected={entry.id === selected.id}
                    onSelect={() => setSelectedId(entry.id)}
                  />
                ))}
              </ul>
            </aside>
            <section className="min-w-0 overflow-y-auto px-5 py-5 sm:px-6" aria-label={t('history.operationDetail')}>
              <DetailPane entry={selected} />
            </section>
          </div>
        </>
      )}
    </WorkspacePage>
  );
}
