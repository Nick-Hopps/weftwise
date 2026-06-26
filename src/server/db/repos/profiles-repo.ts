import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import { userProfiles } from '../schema';
import { type StylePrefs, StylePrefsSchema, DEFAULT_STYLE_PREFS } from '@/server/profile/style';

export interface UserProfile {
  userId: string;
  backgroundSummary: string;
  stylePrefs: StylePrefs;
  version: number;
  onboardedAt: string | null;
  updatedAt: string;
}

function parsePrefs(json: string): StylePrefs {
  try {
    return StylePrefsSchema.parse(JSON.parse(json));
  } catch {
    return DEFAULT_STYLE_PREFS;
  }
}

export function getProfile(userId: string): UserProfile | null {
  const row = getDb().select().from(userProfiles).where(eq(userProfiles.userId, userId)).get();
  if (!row) return null;
  return {
    userId: row.userId,
    backgroundSummary: row.backgroundSummary,
    stylePrefs: parsePrefs(row.stylePrefs),
    version: row.version,
    onboardedAt: row.onboardedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

/** 缺失时返回默认画像，version=0（缓存键仍可用；onboarding 提交后写 v1）。 */
export function getProfileOrDefault(userId: string): UserProfile {
  return (
    getProfile(userId) ?? {
      userId,
      backgroundSummary: '',
      stylePrefs: DEFAULT_STYLE_PREFS,
      version: 0,
      onboardedAt: null,
      updatedAt: '',
    }
  );
}

/** 写画像，version = 旧 version + 1（任意变更都使重塑缓存失效）。 */
export function upsertProfile(
  userId: string,
  patch: { backgroundSummary?: string; stylePrefs?: StylePrefs; markOnboarded?: boolean },
): UserProfile {
  const existing = getProfile(userId);
  const now = new Date().toISOString();
  const next: UserProfile = {
    userId,
    backgroundSummary: patch.backgroundSummary ?? existing?.backgroundSummary ?? '',
    stylePrefs: patch.stylePrefs ?? existing?.stylePrefs ?? DEFAULT_STYLE_PREFS,
    version: (existing?.version ?? 0) + 1,
    onboardedAt: patch.markOnboarded ? (existing?.onboardedAt ?? now) : (existing?.onboardedAt ?? null),
    updatedAt: now,
  };
  const values = {
    userId,
    backgroundSummary: next.backgroundSummary,
    stylePrefs: JSON.stringify(next.stylePrefs),
    version: next.version,
    onboardedAt: next.onboardedAt,
    updatedAt: now,
  };
  getDb()
    .insert(userProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: {
        backgroundSummary: values.backgroundSummary,
        stylePrefs: values.stylePrefs,
        version: values.version,
        onboardedAt: values.onboardedAt,
        updatedAt: now,
      },
    })
    .run();
  return next;
}
