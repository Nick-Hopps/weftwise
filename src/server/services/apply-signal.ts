import { appendSignal, recentSignals } from '@/server/db/repos/signals-repo';
import { getProfileOrDefault, upsertProfile } from '@/server/db/repos/profiles-repo';
import { applySignalsToStyle, type SignalType } from '@/server/profile/signal-reducer';
import { recordEvidence } from '@/server/services/record-evidence';
import type { EvidenceKind } from '@/lib/contracts';

const RECENT_WINDOW = 8;

/**
 * 并存期双写映射：只有这两种信号是 **style-bearing** 的，也只有它们在证据表里有对应
 * 语义。`view_original` 是归因埋点；`simplify_click` / `deepen_click` 的入口从未实现。
 */
const SIGNAL_TO_EVIDENCE: Partial<Record<SignalType, EvidenceKind>> = {
  too_hard: 'self-report-hard',
  too_easy: 'self-report-easy',
};

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

  // 并存加新（三步替换的第一步）：旧表继续是 reducer 的输入，行为不变；
  // 证据表同步积累一份，等任务 12 的原子切换有数据可用。
  // 缺 subjectId 或 slug 时跳过——证据必须能归属到确定的页，没有「全局证据」这种东西。
  const evidenceKind = SIGNAL_TO_EVIDENCE[type];
  if (evidenceKind && ctx?.subjectId && ctx?.slug) {
    recordEvidence({ userId, subjectId: ctx.subjectId, slug: ctx.slug, kind: evidenceKind });
  }

  const recent = recentSignals(userId, RECENT_WINDOW);
  const current = getProfileOrDefault(userId);
  const { prefs, changed } = applySignalsToStyle(current.stylePrefs, recent);
  if (!changed) return { changed: false, version: current.version };
  const updated = upsertProfile(userId, { stylePrefs: prefs });
  return { changed: true, version: updated.version };
}
