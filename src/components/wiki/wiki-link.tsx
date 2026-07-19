'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/i18n-provider';

interface WikiLinkProps {
  href: string;
  slug: string;
  /** Subject slug when the link explicitly targets a different subject. */
  subjectSlug?: string;
  children?: React.ReactNode;
  broken?: boolean;
}

interface PagePreview {
  title: string;
  summary: string;
}

// Simple in-memory cache to avoid redundant fetches.
// Keyed by `<subjectSlug>:<slug>` so same-slug pages from different subjects
// don't collide — including same-subject links, which fall back to the active
// subject slug rather than the bare slug.
const previewCache = new Map<string, PagePreview | null>();

function previewCacheKey(slug: string, subjectSlug: string): string {
  return `${subjectSlug}:${slug}`;
}

export default function WikiLink({
  href,
  slug,
  subjectSlug,
  children,
  broken = false,
}: WikiLinkProps) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<PagePreview | null>(null);
  const [showPeek, setShowPeek] = useState(false);
  const [loading, setLoading] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { slug: currentSubjectSlug } = useCurrentSubject();

  const fetchPreview = useCallback(async () => {
    if (broken) return;

    const effectiveSubjectSlug = subjectSlug ?? currentSubjectSlug;
    const cacheKey = previewCacheKey(slug, effectiveSubjectSlug);

    if (previewCache.has(cacheKey)) {
      setPreview(previewCache.get(cacheKey) ?? null);
      setShowPeek(true);
      return;
    }

    setLoading(true);
    try {
      const previewPath =
        `/api/pages/${slug}?s=${encodeURIComponent(effectiveSubjectSlug)}`;
      const res = await apiFetch(previewPath);
      if (!res.ok) {
        previewCache.set(cacheKey, null);
        setPreview(null);
      } else {
        const data = await res.json();
        const p: PagePreview = {
          title: data.title ?? slug,
          summary: data.summary ?? '',
        };
        previewCache.set(cacheKey, p);
        setPreview(p);
      }
    } catch {
      previewCache.set(cacheKey, null);
    } finally {
      setLoading(false);
      setShowPeek(true);
    }
  }, [slug, subjectSlug, currentSubjectSlug, broken]);

  const handleMouseEnter = () => {
    clearTimeout(hideTimerRef.current);
    fetchTimerRef.current = setTimeout(fetchPreview, 300);
  };

  const handleMouseLeave = () => {
    clearTimeout(fetchTimerRef.current);
    hideTimerRef.current = setTimeout(() => setShowPeek(false), 200);
  };

  if (broken) {
    return (
      <span
        title={t('wiki.link.notFound')}
        className="text-danger underline decoration-dashed underline-offset-4 cursor-help"
      >
        {children}
      </span>
    );
  }

  return (
    <span
      className="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Link
        href={href}
        data-wiki-slug={slug}
        className="text-link underline decoration-1 underline-offset-4 decoration-link/40 hover:text-link-hover hover:decoration-link-hover transition-colors duration-fast"
      >
        {children}
      </Link>

      {showPeek && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 z-tooltip pointer-events-none"
          onMouseEnter={() => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }}
          onMouseLeave={handleMouseLeave}
        >
          <div className={cn(
            'pointer-events-auto rounded-lg border border-border',
            'bg-surface shadow-md p-3 animate-slide-down',
          )}>
            {loading ? (
              <div className="h-4 w-3/4 rounded bg-subtle animate-pulse" />
            ) : preview ? (
              <>
                <p className="text-sm font-semibold text-foreground truncate">
                  {preview.title}
                </p>
                {preview.summary && (
                  <p className="text-xs text-foreground-secondary mt-1 line-clamp-3">
                    {preview.summary}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-foreground-tertiary italic">{t('wiki.link.noPreview')}</p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
