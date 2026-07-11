'use client';

import { useCallback } from 'react';
import { useUIStore } from '@/stores/ui-store';

/**
 * Thin wrapper around `fetch` for client-side API calls.
 *
 * Authentication is handled via HttpOnly session cookie (set by POST /api/session).
 * Cookies are sent automatically by the browser — no manual header injection needed.
 *
 * Falls back to Bearer token from NEXT_PUBLIC_WIKI_API_KEY for backward compatibility.
 */
export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Backward compat: if the legacy env var is set, inject Bearer header
  const apiKey =
    typeof window !== 'undefined'
      ? (process.env.NEXT_PUBLIC_WIKI_API_KEY ?? '')
      : '';

  if (apiKey) {
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }
    return fetch(input, { ...init, headers, credentials: 'same-origin' });
  }

  // Cookie-based auth: credentials: 'same-origin' ensures cookies are sent
  return fetch(input, { ...init, credentials: 'same-origin' });
}

const SUBJECT_AGNOSTIC_EXACT = new Set([
  '/api/session',
  '/api/reset',
  '/api/settings',
]);

const SUBJECT_AGNOSTIC_PREFIXES = [
  '/api/subjects', // /api/subjects and /api/subjects/[id]
  '/api/jobs',     // /api/jobs, /api/jobs/[id], /api/jobs/[id]/events
];

function isSubjectAgnostic(pathname: string): boolean {
  if (SUBJECT_AGNOSTIC_EXACT.has(pathname)) return true;
  return SUBJECT_AGNOSTIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function appendSubjectId(path: string, subjectId: string): string {
  // Skip routes that are subject-agnostic by design.
  const queryStart = path.indexOf('?');
  const pathname = queryStart === -1 ? path : path.slice(0, queryStart);
  if (isSubjectAgnostic(pathname)) return path;
  // Don't override an explicit subjectId already on the URL.
  if (queryStart !== -1) {
    const search = new URLSearchParams(path.slice(queryStart + 1));
    if (search.has('subjectId')) return path;
  }
  const sep = queryStart === -1 ? '?' : '&';
  return `${path}${sep}subjectId=${encodeURIComponent(subjectId)}`;
}

/**
 * Hook returning a subject-aware variant of {@link apiFetch}.
 *
 * Reads the current subject from {@link useUIStore} and auto-appends
 * `?subjectId=<id>` to GET URLs whose path is not already subject-scoped.
 *
 * For POST/PATCH/DELETE the caller still owns the body — pass `subjectId`
 * inside `body` (or as a query param) when needed. This includes pending-action
 * approve/reject requests. The hook only handles the common read-side ergonomic case.
 *
 * SSR / non-React callers should keep using the bare {@link apiFetch}.
 */
export function useApiFetch(): (
  input: string,
  init?: RequestInit,
) => Promise<Response> {
  const subjectId = useUIStore((s) => s.currentSubjectId);

  return useCallback(
    (input: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && subjectId) {
        return apiFetch(appendSubjectId(input, subjectId), init);
      }
      return apiFetch(input, init);
    },
    [subjectId],
  );
}
