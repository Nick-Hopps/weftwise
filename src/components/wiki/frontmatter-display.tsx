'use client';

import { Tag } from '@/components/ui/tag';

interface FrontmatterDisplayProps {
  title: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
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
}: FrontmatterDisplayProps) {
  const hasProps = tags.length > 0 || sources.length > 0 || created || updated;

  return (
    <div className="pb-6 mb-8 border-b border-border">
      <h1 className="text-2xl font-semibold tracking-tight text-prose-heading mb-5 leading-tight">
        {title}
      </h1>

      {hasProps && (
        <dl className="grid grid-cols-[88px_1fr] gap-y-1.5 text-sm items-start">
          {tags.length > 0 && (
            <>
              <dt className="text-foreground-secondary pt-0.5">Tags</dt>
              <dd className="flex flex-wrap gap-1">
                {tags.map((t) => (
                  <Tag key={t} tone="neutral" size="base">
                    {t}
                  </Tag>
                ))}
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
