import { appendSignal, type SignalType } from '@/server/db/repos/signals-repo';
import { listStyleEvidence } from '@/server/db/repos/evidence-repo';
import { getProfile, getProfileOrDefault, upsertProfile } from '@/server/db/repos/profiles-repo';
import { applyEvidenceToStyle } from '@/server/profile/signal-reducer';
import { recordEvidence } from '@/server/services/record-evidence';
import type { EvidenceKind } from '@/lib/contracts';

/**
 * 信号 → 证据的映射：只有这两种是 **style-bearing** 的。
 * `view_original` 是归因埋点；`simplify_click` / `deepen_click` 的入口从未实现。
 */
const SIGNAL_TO_EVIDENCE: Partial<Record<SignalType, EvidenceKind>> = {
  too_hard: 'self-report-hard',
  too_easy: 'self-report-easy',
};

/**
 * 落一条证据 → 取消费边界之后、时间窗内的 style-bearing 证据 → 确定性 reducer 评估
 * → 达阈值才 upsert 新画像。返回是否变更及当前 version（前端据 changed 失效 lens 缓存）。
 */
export function applySignal(
  userId: string,
  type: SignalType,
  ctx?: { subjectId?: string | null; slug?: string | null; viewedSource?: 'canonical' | 'reshape' | null },
): { changed: boolean; version: number } {
  // 旧表仍在双写（三步替换的第二步：已切读，未删旧）。任务 13 删表时一并移除。
  appendSignal({ userId, type, subjectId: ctx?.subjectId ?? null, slug: ctx?.slug ?? null });

  const evidenceKind = SIGNAL_TO_EVIDENCE[type];
  // 缺 subjectId 或 slug 时跳过——证据必须能归属到确定的页。
  if (evidenceKind && ctx?.subjectId && ctx?.slug) {
    recordEvidence({
      userId,
      subjectId: ctx.subjectId,
      slug: ctx.slug,
      kind: evidenceKind,
      detail: ctx.viewedSource ? { viewedSource: ctx.viewedSource } : undefined,
    });
  }

  // A6：尚无画像行的用户只落证据、**跳过 upsertProfile**。
  //
  // 原实现照写不误，结果 `version` 涨到 1 而 `onboardedAt` 仍为 null，onboarding 弹窗
  // 持续弹。证据不丢——用户真的完成 onboarding 后，reducer 自然消费到这些历史证据
  // （此时 stylePrefsUpdatedAt 仍为 null，边界不设限）。
  const existing = getProfile(userId);
  if (!existing) return { changed: false, version: getProfileOrDefault(userId).version };

  const evidence = listStyleEvidence(userId, existing.stylePrefsUpdatedAt);
  const { prefs, changed } = applyEvidenceToStyle(existing.stylePrefs, evidence, {
    now: new Date(),
    since: existing.stylePrefsUpdatedAt,
  });
  if (!changed) return { changed: false, version: existing.version };

  const updated = upsertProfile(userId, { stylePrefs: prefs });
  return { changed: true, version: updated.version };
}
