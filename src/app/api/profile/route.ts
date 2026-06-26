import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { getProfileOrDefault, upsertProfile, type UserProfile } from '@/server/db/repos/profiles-repo';
import { StylePrefsSchema } from '@/server/profile/style';
import type { UserProfileDTO } from '@/lib/contracts';

export const runtime = 'nodejs';

function toDTO(p: UserProfile): UserProfileDTO {
  return {
    backgroundSummary: p.backgroundSummary,
    stylePrefs: p.stylePrefs,
    version: p.version,
    onboardedAt: p.onboardedAt,
  };
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const userId = resolveUserId(request);
  const p = getProfileOrDefault(userId);
  return NextResponse.json({ profile: toDTO(p), onboarded: p.onboardedAt !== null });
}

const PutBody = z.object({
  backgroundSummary: z.string().max(2000).optional(),
  stylePrefs: StylePrefsSchema.optional(),
  markOnboarded: z.boolean().optional(),
});

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;
  const userId = resolveUserId(request);

  let parsed: z.infer<typeof PutBody>;
  try {
    parsed = PutBody.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid profile body' }, { status: 400 });
  }
  const updated = upsertProfile(userId, parsed);
  return NextResponse.json({ profile: toDTO(updated) });
}
