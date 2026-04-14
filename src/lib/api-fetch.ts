'use client';

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
