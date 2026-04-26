import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import {
  getWikiLanguage,
  setWikiLanguage,
} from '@/server/db/repos/settings-repo';
import { WikiLanguageSchema, type AppSettings } from '@/lib/contracts';

export const runtime = 'nodejs';

/**
 * GET /api/settings
 * Returns the current global app settings.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body: AppSettings = { wikiLanguage: getWikiLanguage() };
  return NextResponse.json(body);
}

const PutBodySchema = z.object({
  wikiLanguage: WikiLanguageSchema.optional(),
});

/**
 * PUT /api/settings
 * Body: { wikiLanguage?: string }
 *
 * Returns the post-update settings. Omitting all fields is a no-op that
 * just echoes the current state.
 */
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (parsed.data.wikiLanguage !== undefined) {
    setWikiLanguage(parsed.data.wikiLanguage);
  }

  const result: AppSettings = { wikiLanguage: getWikiLanguage() };
  return NextResponse.json(result);
}
