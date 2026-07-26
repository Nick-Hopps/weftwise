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
  /**
   * reducer 的消费边界：仅在旋钮**真的变化**时推进。
   *
   * 不能复用 `updatedAt`——后者任何画像写入都会变（改背景自述、onboarding 提交），
   * 拿它当边界会误清信号窗口，读者会觉得「我明明点过好几次太难，怎么一点反应都没有」。
   */
  stylePrefsUpdatedAt: string | null;
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
    stylePrefsUpdatedAt: row.stylePrefsUpdatedAt ?? null,
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
      stylePrefsUpdatedAt: null,
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
  // 只有旋钮真的动了才推进边界；改背景自述不算。
  const stylePrefsChanged =
    patch.stylePrefs !== undefined &&
    JSON.stringify(patch.stylePrefs) !== JSON.stringify(existing?.stylePrefs ?? DEFAULT_STYLE_PREFS);
  const next: UserProfile = {
    userId,
    backgroundSummary: patch.backgroundSummary ?? existing?.backgroundSummary ?? '',
    stylePrefs: patch.stylePrefs ?? existing?.stylePrefs ?? DEFAULT_STYLE_PREFS,
    version: (existing?.version ?? 0) + 1,
    onboardedAt: patch.markOnboarded ? (existing?.onboardedAt ?? now) : (existing?.onboardedAt ?? null),
    updatedAt: now,
    stylePrefsUpdatedAt: stylePrefsChanged ? now : (existing?.stylePrefsUpdatedAt ?? null),
  };
  const values = {
    userId,
    backgroundSummary: next.backgroundSummary,
    stylePrefs: JSON.stringify(next.stylePrefs),
    version: next.version,
    onboardedAt: next.onboardedAt,
    updatedAt: now,
    stylePrefsUpdatedAt: next.stylePrefsUpdatedAt,
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
        stylePrefsUpdatedAt: values.stylePrefsUpdatedAt,
      },
    })
    .run();
  return next;
}
