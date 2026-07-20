'use client';

import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  FileQuestion,
  GitMerge,
  MoreHorizontal,
  Tag as TagIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import type { TagReviewQueue } from '@/lib/tags';
import { useI18n } from '@/components/i18n-provider';

function SectionHeading({
  id,
  title,
  count,
  description,
}: {
  id: string;
  title: string;
  count: number;
  description: string;
}) {
  return (
    <header className="mb-2 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 id={id} className="text-xs font-semibold text-foreground-secondary">
          {title}
        </h2>
        <p className="mt-1 text-xs text-foreground-secondary">{description}</p>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-foreground-tertiary">{count}</span>
    </header>
  );
}

export function TagReviewQueueView({
  queue,
  subjectSlug,
  actionDisabled,
  onManageTag,
}: {
  queue: TagReviewQueue;
  subjectSlug: string;
  actionDisabled: boolean;
  onManageTag(sourceTag: string, suggestedTarget?: string): void;
}) {
  const { t, formatDate } = useI18n();
  if (queue.issueCount === 0) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center border-y border-border-subtle px-4 text-center">
        <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
        <h2 className="mt-3 text-sm font-medium text-foreground">{t('tags.reviewClear')}</h2>
        <p className="mt-1 max-w-sm text-xs leading-5 text-foreground-tertiary">
          {t('tags.review.clearDescription')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {queue.variantGroups.length > 0 && (
        <section aria-labelledby="format-variants-heading">
          <SectionHeading
            id="format-variants-heading"
            title={t('tags.formatVariants')}
            count={queue.variantGroups.reduce((sum, group) => sum + group.variants.length, 0)}
            description={t('tags.review.variantsDescription')}
          />
          <ul className="divide-y divide-border-subtle border-y border-border-subtle">
            {queue.variantGroups.flatMap((group) => group.variants.map((variant) => (
              <li
                key={`${group.canonical.tag}:${variant.tag}`}
                className="flex flex-col gap-3 px-2 py-3 transition-colors hover:bg-subtle sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                    <span className="max-w-full truncate">#{variant.tag}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" aria-hidden />
                    <span className="max-w-full truncate text-accent-strong">#{group.canonical.tag}</span>
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-foreground-tertiary">
                    {t('tags.review.mergeSummary', {
                      source: t(variant.count === 1
                        ? 'tags.review.pageCount.one'
                        : 'tags.review.pageCount.many', { count: variant.count }),
                      target: t(group.canonical.count === 1
                        ? 'tags.review.existingPageCount.one'
                        : 'tags.review.existingPageCount.many', { count: group.canonical.count }),
                    })}
                  </p>
                </div>
                <Button
                  intent="outline"
                  size="sm"
                  className="self-start sm:self-auto"
                  disabled={actionDisabled}
                  onClick={() => onManageTag(variant.tag, group.canonical.tag)}
                  title={actionDisabled ? t('tags.resolveCurrentAction') : undefined}
                >
                  <GitMerge className="h-3.5 w-3.5" aria-hidden />
                  {t('tags.review.previewMerge')}
                </Button>
              </li>
            )))}
          </ul>
        </section>
      )}

      {queue.singletonTags.length > 0 && (
        <section aria-labelledby="single-use-tags-heading">
          <SectionHeading
            id="single-use-tags-heading"
            title={t('tags.singleUse')}
            count={queue.singletonTags.length}
            description={t('tags.review.singleUseDescription')}
          />
          <ul className="divide-y divide-border-subtle border-y border-border-subtle">
            {queue.singletonTags.map((summary) => {
              const page = summary.pages[0];
              const tagHref = `/tags/${encodeURIComponent(summary.tag)}?s=${encodeURIComponent(subjectSlug)}`;
              return (
                <li
                  key={summary.tag}
                  className="group flex min-h-16 items-center gap-3 px-2 py-2.5 transition-colors hover:bg-subtle"
                >
                  <TagIcon className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={tagHref}
                      className="inline-block max-w-full truncate text-sm font-medium text-foreground transition-colors group-hover:text-accent-strong focus-ring"
                    >
                      {summary.tag}
                    </Link>
                    {page && (
                      <p className="mt-1 truncate text-xs text-foreground-tertiary">
                        {t('tags.review.usedOnlyOn', { page: page.title })}
                      </p>
                    )}
                  </div>
                  <span className="hidden text-xs tabular-nums text-foreground-tertiary sm:block">
                    {summary.updatedAt ? formatDate(summary.updatedAt, { month: 'short', day: 'numeric' }) : '—'}
                  </span>
                  <IconButton
                    size="base"
                    disabled={actionDisabled}
                    onClick={() => onManageTag(summary.tag)}
                    aria-label={t('tags.manage', { tag: summary.tag })}
                    title={actionDisabled
                      ? t('tags.resolveCurrentAction')
                      : t('tags.manage', { tag: summary.tag })}
                  >
                    <MoreHorizontal aria-hidden />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {queue.untaggedPages.length > 0 && (
        <section aria-labelledby="untagged-pages-heading">
          <SectionHeading
            id="untagged-pages-heading"
            title={t('tags.untagged')}
            count={queue.untaggedPages.length}
            description={t('tags.review.untaggedDescription')}
          />
          <ul className="divide-y divide-border-subtle border-y border-border-subtle">
            {queue.untaggedPages.map((page) => (
              <li key={`${page.subjectId}:${page.slug}`} className="group px-2 py-3 transition-colors hover:bg-subtle">
                <Link
                  href={`/wiki/${page.slug}?s=${encodeURIComponent(subjectSlug)}`}
                  className="flex min-w-0 items-start gap-3 focus-ring"
                >
                  <FileQuestion className="mt-0.5 h-4 w-4 shrink-0 text-foreground-tertiary group-hover:text-accent" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium text-foreground group-hover:text-accent-strong">
                        {page.title}
                      </span>
                      <time className="shrink-0 text-xs tabular-nums text-foreground-tertiary" dateTime={page.updatedAt}>
                        {formatDate(page.updatedAt, { month: 'short', day: 'numeric' })}
                      </time>
                    </div>
                    {page.summary && (
                      <p className="mt-1 line-clamp-1 text-xs leading-5 text-foreground-tertiary">{page.summary}</p>
                    )}
                  </div>
                  <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground-tertiary transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
