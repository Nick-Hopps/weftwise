import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

const SESSION_COOKIE_NAME = 'wiki_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function hashToken(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Create an authenticated session response (sets HttpOnly cookie).
 */
export function createSessionResponse(apiKey: string): NextResponse {
  const token = hashToken(apiKey);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
  return res;
}

/**
 * Authentication middleware.
 *
 * When WIKI_API_KEY env var is set, requests must provide credentials via:
 * 1. HttpOnly session cookie (set by POST /api/session)
 * 2. Authorization: Bearer <key> header (for API clients)
 *
 * When WIKI_API_KEY is not set, all requests are allowed (local dev mode).
 */
export function requireAuth(request: NextRequest): NextResponse | null {
  const requiredKey = process.env.WIKI_API_KEY;
  if (!requiredKey) {
    return null;
  }

  // Check session cookie
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie && sessionCookie === hashToken(requiredKey)) {
    return null;
  }

  // Check Authorization header
  const authHeader = request.headers.get('authorization') ?? '';
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7) === requiredKey) {
    return null;
  }

  // Check apiKey query parameter (fallback for EventSource which cannot send headers)
  const apiKeyParam = request.nextUrl.searchParams.get('apiKey');
  if (apiKeyParam && apiKeyParam === requiredKey) {
    return null;
  }

  return NextResponse.json(
    { error: 'Unauthorized. Login via POST /api/session or provide Authorization header.' },
    { status: 401 }
  );
}

/**
 * CSRF protection for mutation endpoints.
 * Checks that the Origin header matches the request host.
 */
export function requireCsrf(request: NextRequest): NextResponse | null {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return null;
  }

  // Skip CSRF in dev mode when no key configured
  if (!process.env.WIKI_API_KEY) return null;

  // Bearer token requests are not browser-initiated, skip CSRF
  const authHeader = request.headers.get('authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) return null;

  const origin = request.headers.get('origin');
  if (!origin) return null; // non-browser client

  const requestHost = request.nextUrl.host;
  try {
    const originHost = new URL(origin).host;
    if (originHost !== requestHost) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid Origin header' }, { status: 403 });
  }

  return null;
}
