'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-fetch';
import { cn } from '@/lib/cn';

interface WikiLinkProps {
  href: string;
  slug: string;
  children: React.ReactNode;
  broken?: boolean;
}

interface PagePreview {
  title: string;
  summary: string;
}

// Simple in-memory cache to avoid redundant fetches
const previewCache = new Map<string, PagePreview | null>();

export default function WikiLink({
  href,
  slug,
  children,
  broken = false,
}: WikiLinkProps) {
  const [preview, setPreview] = useState<PagePreview | null>(null);
  const [showPeek, setShowPeek] = useState(false);
  const [loading, setLoading] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchPreview = useCallback(async () => {
    if (broken) return;

    if (previewCache.has(slug)) {
      setPreview(previewCache.get(slug) ?? null);
      setShowPeek(true);
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch(`/api/pages/${slug}`);
      if (!res.ok) {
        previewCache.set(slug, null);
        setPreview(null);
      } else {
        const data = await res.json();
        const p: PagePreview = {
          title: data.title ?? slug,
          summary: data.summary ?? '',
        };
        previewCache.set(slug, p);
        setPreview(p);
      }
    } catch {
      previewCache.set(slug, null);
    } finally {
      setLoading(false);
      setShowPeek(true);
    }
  }, [slug, broken]);

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
        title="Page not found"
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
        className="text-accent underline decoration-1 underline-offset-4 decoration-accent/40 hover:decoration-accent transition-colors duration-fast"
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
              <p className="text-xs text-foreground-tertiary italic">No preview available</p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
