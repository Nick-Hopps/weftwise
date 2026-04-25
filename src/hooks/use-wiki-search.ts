'use client';
import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';

export interface SearchResult {
  page: {
    slug: string;
    title: string;
    updatedAt?: string;
  };
  snippet: string;
  rank: number;
}

interface UseWikiSearchResult {
  results: SearchResult[];
  isLoading: boolean;
}

export function useWikiSearch(
  query: string,
  debounceMs: number = 300
): UseWikiSearchResult {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { id: subjectId } = useCurrentSubject();

  useEffect(() => {
    const trimmed = query.trim();

    if (!trimmed || !subjectId) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const url =
          `/api/search?q=${encodeURIComponent(trimmed)}` +
          `&subjectId=${encodeURIComponent(subjectId)}`;
        const response = await apiFetch(url, { signal: controller.signal });
        if (!response.ok) {
          setResults([]);
          return;
        }
        const data = (await response.json()) as { results: SearchResult[] };
        setResults(data.results ?? []);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, debounceMs, subjectId]);

  return { results, isLoading };
}
