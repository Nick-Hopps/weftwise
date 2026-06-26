import { appendSignal, recentSignals } from '@/server/db/repos/signals-repo';
import { getProfileOrDefault, upsertProfile } from '@/server/db/repos/profiles-repo';
import { applySignalsToStyle, type SignalType } from '@/server/profile/signal-reducer';

const RECENT_WINDOW = 8;

/**
 * 落一条信号 → 取最近窗口 → 确定性 reducer 评估 → 达阈值才 upsert 新画像。
 * 返回是否变更及当前 version（前端据 changed 决定是否失效 lens 缓存）。
 */
export function applySignal(
  userId: string,
  type: SignalType,
  ctx?: { subjectId?: string | null; slug?: string | null },
): { changed: boolean; version: number } {
  appendSignal({ userId, type, subjectId: ctx?.subjectId ?? null, slug: ctx?.slug ?? null });
  const recent = recentSignals(userId, RECENT_WINDOW);
  const current = getProfileOrDefault(userId);
  const { prefs, changed } = applySignalsToStyle(current.stylePrefs, recent);
  if (!changed) return { changed: false, version: current.version };
  const updated = upsertProfile(userId, { stylePrefs: prefs });
  return { changed: true, version: updated.version };
}
