import { NextRequest, NextResponse } from 'next/server';
import { createSessionResponse } from '@/server/middleware/auth';

export const runtime = 'nodejs';

/**
 * POST /api/session
 * Body: { password: string }
 *
 * Verifies the password against WIKI_API_KEY and sets an HttpOnly session cookie.
 */
export async function POST(request: NextRequest) {
  const requiredKey = process.env.WIKI_API_KEY;

  if (!requiredKey) {
    return NextResponse.json(
      { error: 'No API key configured. Authentication is disabled in local mode.' },
      { status: 400 },
    );
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.password || body.password !== requiredKey) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  return createSessionResponse(requiredKey);
}
