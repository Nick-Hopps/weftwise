'use client';

import Link from 'next/link';
import { Pencil } from 'lucide-react';
import { Tag } from '@/components/ui/tag';
import { TagLink } from '@/components/wiki/tag-link';
interface FrontmatterDisplayProps {
  title: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
  editHref?: string;
  subjectSlug?: string;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Page frontmatter rendered as a Linear-issue-style property list:
 *  - H1 title
 *  - 88px fixed-width label column + flexible value column
 *  - Hairline border separator from body
 */
export default function FrontmatterDisplay({
  title,
  tags,
  sources,
  created,
  updated,
  editHref,
  subjectSlug,
}: FrontmatterDisplayProps) {
  const hasProps = tags.length > 0 || sources.length > 0 || created || updated;

  return (
    <div className="pb-6 mb-8 border-b border-border">
      <div className="flex items-start justify-between gap-3 mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-prose-heading leading-tight">
          {title}
        </h1>
        <div className="flex items-center gap-2 shrink-0">
          {editHref && (
            <Link
              href={editHref}
              data-tip="Edit this page"
              className="tip tip-b shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Link>
          )}
        </div>
      </div>

      {hasProps && (
        <dl className="grid grid-cols-[88px_1fr] gap-y-1.5 text-sm items-start">
          {tags.filter((t) => t !== 'meta').length > 0 && (
            <>
              <dt className="text-foreground-secondary pt-0.5">Tags</dt>
              <dd className="flex flex-wrap gap-1">
                {tags.filter((t) => t !== 'meta').map((t) =>
                  subjectSlug ? (
                    <TagLink key={t} tag={t} subjectSlug={subjectSlug} size="base" />
                  ) : (
                    <Tag key={t} tone="neutral" size="base">{t}</Tag>
                  ),
                )}
              </dd>
            </>
          )}
          {sources.length > 0 && (
            <>
              <dt className="text-foreground-secondary pt-0.5">Sources</dt>
              <dd className="text-sm text-foreground-secondary">
                {sources.join(', ')}
              </dd>
            </>
          )}
          {created && (
            <>
              <dt className="text-foreground-secondary">Created</dt>
              <dd>
                <time dateTime={created} className="font-mono text-xs text-foreground">
                  {formatDate(created)}
                </time>
              </dd>
            </>
          )}
          {updated && (
            <>
              <dt className="text-foreground-secondary">Updated</dt>
              <dd>
                <time dateTime={updated} className="font-mono text-xs text-foreground">
                  {formatDate(updated)}
                </time>
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
