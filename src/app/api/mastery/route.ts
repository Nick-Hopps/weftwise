import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getAllPages, isMetaPage } from '@/server/db/repos/pages-repo';
import { listForPage, listForSubject } from '@/server/db/repos/evidence-repo';
import { deriveMastery } from '@/server/profile/mastery';
import type { MasteryVerdictLite } from '@/lib/contracts';

export const runtime = 'nodejs';

/**
 * 掌握度读取。无缓存、无失效——`page_evidence` 是唯一真实源，
 * `deriveMastery` 是纯函数，衰减天然按 `now` 算，不需要任何调度。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;
  const subjectId = resolution.subject.id;
  const userId = resolveUserId(request);

  // 与 `/api/graph` 同口径排除 meta 页：index/log 是确定性渲染的系统页，
  // 谈不上「掌握」，混进图层只会多两个永远灰着的节点。
  const readableSlugs = new Set(
    getAllPages(subjectId).filter((p) => !isMetaPage(p)).map((p) => p.slug),
  );

  const now = new Date();
  const slug = request.nextUrl.searchParams.get('slug');

  if (slug) {
    if (!readableSlugs.has(slug)) {
      return NextResponse.json({ error: `Page "${slug}" not found` }, { status: 404 });
    }
    // 单页：带 `recent`，供审计面展开看支撑这条判定的原始证据。
    return NextResponse.json({ mastery: deriveMastery(listForPage(userId, subjectId, slug), now) });
  }

  // 全量：**刻意不带 `recent`**。图层只需要着色所需的 state/confidence，逐页塞进
  // 最多 MAX_RECENT_EVIDENCE 条证据会让响应体随使用量线性膨胀，而其中 99% 永远不会
  // 被展开看。证据明细在 tap 节点时按单页取。
  const masteryBySlug: Record<string, MasteryVerdictLite> = {};
  for (const [pageSlug, rows] of listForSubject(userId, subjectId)) {
    if (!readableSlugs.has(pageSlug)) continue;
    const { recent, ...lite } = deriveMastery(rows, now);
    void recent;
    masteryBySlug[pageSlug] = lite;
  }

  return NextResponse.json({ masteryBySlug });
}
