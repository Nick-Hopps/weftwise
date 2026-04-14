'use client';

import { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-fetch';

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

    // Check cache first
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
    // Small delay before showing to avoid flash on quick mouse passes
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
        className="text-red-500 dark:text-red-400 underline decoration-dashed underline-offset-2 cursor-help"
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
        className="text-indigo-600 dark:text-indigo-400 transition-all duration-150 hover:underline hover:underline-offset-2 hover:text-indigo-700 dark:hover:text-indigo-300"
      >
        {children}
      </Link>

      {/* Peek popover */}
      {showPeek && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 z-40 pointer-events-none"
          onMouseEnter={() => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }}
          onMouseLeave={handleMouseLeave}
        >
          <div className="pointer-events-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg p-3">
            {loading ? (
              <div className="h-4 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
            ) : preview ? (
              <>
                <p className="text-sm font-semibold text-zinc-900 dark:text-slate-100 truncate">
                  {preview.title}
                </p>
                {preview.summary && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-3">
                    {preview.summary}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-zinc-400 italic">No preview available</p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
