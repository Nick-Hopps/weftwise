'use client';

import type { ReactNode } from 'react';
import { Tag } from '@/components/ui/tag';
import { TagLink } from '@/components/wiki/tag-link';
import { useI18n } from '@/components/i18n-provider';
interface FrontmatterDisplayProps {
  title: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
  actions?: ReactNode;
  subjectSlug?: string;
}

/**
 * 阅读页头：标题承担首要层级，属性压缩为可换行的单行摘要，避免正文开始前
 * 出现大块表格式元数据。
 */
export default function FrontmatterDisplay({
  title,
  tags,
  sources,
  created,
  updated,
  actions,
  subjectSlug,
}: FrontmatterDisplayProps) {
  const { t, formatDate } = useI18n();
  const hasProps = tags.length > 0 || sources.length > 0 || created || updated;

  return (
    <header className="mb-10 border-b border-border-subtle pb-7">
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <h1 className="min-w-0 font-display text-3xl font-semibold leading-[1.18] tracking-normal text-prose-heading sm:shrink-0 sm:text-[36px]">
          {title}
        </h1>
        {actions}
      </div>

      {hasProps && (
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-foreground-tertiary">
          {tags.filter((t) => t !== 'meta').length > 0 && (
            <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
              <dt className="sr-only">{t('wiki.frontmatter.tags')}</dt>
              <dd className="flex flex-wrap gap-1.5">
                {tags.filter((t) => t !== 'meta').map((t) =>
                  subjectSlug ? (
                    <TagLink key={t} tag={t} subjectSlug={subjectSlug} size="base" />
                  ) : (
                    <Tag key={t} tone="neutral" size="base">{t}</Tag>
                  ),
                )}
              </dd>
            </div>
          )}
          {sources.length > 0 && (
            <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto">
              <dt>{t('wiki.frontmatter.sources')}</dt>
              <dd className="max-w-[320px] truncate text-foreground-secondary" title={sources.join(', ')}>
                {sources.join(', ')}
              </dd>
            </div>
          )}
          {created && (
            <div className="flex items-center gap-1.5">
              <dt>{t('wiki.frontmatter.created')}</dt>
              <dd>
                <time dateTime={created} className="font-mono text-foreground-secondary">
                  {formatDate(created, { year: 'numeric', month: 'short', day: 'numeric' })}
                </time>
              </dd>
            </div>
          )}
          {updated && (
            <div className="flex items-center gap-1.5">
              <dt>{t('wiki.frontmatter.updated')}</dt>
              <dd>
                <time dateTime={updated} className="font-mono text-foreground-secondary">
                  {formatDate(updated, { year: 'numeric', month: 'short', day: 'numeric' })}
                </time>
              </dd>
            </div>
          )}
        </dl>
      )}
    </header>
  );
}
