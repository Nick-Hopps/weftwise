import { listStyleEvidence } from '@/server/db/repos/evidence-repo';
import { getProfile, upsertProfile } from '@/server/db/repos/profiles-repo';
import { applyEvidenceToStyle } from '@/server/profile/signal-reducer';

export interface StyleLearningResult {
  changed: boolean;
  version: number;
}

/**
 * 风格学习闭环：取消费边界之后、时间窗内的 style-bearing 证据 → 确定性 reducer 评估
 * → 达阈值才 upsert 新画像。
 *
 * 调用方是 `POST /api/evidence`，且**只在写入 style-bearing 证据后**调用——
 * 其余证据说的是掌握度不是讲法，跑一遍 reducer 纯属浪费（且白名单会把它们全滤掉）。
 */
export function learnStyleFromEvidence(userId: string): StyleLearningResult {
  // A6：尚无画像行的用户跳过。
  //
  // 原实现照写不误，结果 `version` 涨到 1 而 `onboardedAt` 仍为 null，onboarding 弹窗
  // 持续弹。证据不丢——用户真的完成 onboarding 后，`stylePrefsUpdatedAt` 仍为 null，
  // 边界不设限，reducer 自然消费到这些历史证据。
  const existing = getProfile(userId);
  if (!existing) return { changed: false, version: 0 };

  const evidence = listStyleEvidence(userId, existing.stylePrefsUpdatedAt);
  const { prefs, changed } = applyEvidenceToStyle(existing.stylePrefs, evidence, {
    now: new Date(),
    since: existing.stylePrefsUpdatedAt,
  });
  if (!changed) return { changed: false, version: existing.version };

  return { changed: true, version: upsertProfile(userId, { stylePrefs: prefs }).version };
}
