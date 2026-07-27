import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getAllPages, isMetaPage } from '@/server/db/repos/pages-repo';
import { listForPage, listForSubject } from '@/server/db/repos/evidence-repo';
import { deriveMastery, isDueForReview } from '@/server/profile/mastery';
import type { MasteryDueEntry, MasteryDueResult, MasteryVerdictLite } from '@/lib/contracts';

export const runtime = 'nodejs';

/**
 * 复习清单单次返回上限。长期贴顶说明复习跟不上掌握的产生速度——届时该考虑的是
 * `mastered` 的达成门槛或提醒方式，而不是简单加大这个数。
 */
const DUE_LIMIT = 20;

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
  // **三条分支共用这一份口径**，不得各自过滤。
  const readablePages = new Map(
    getAllPages(subjectId)
      .filter((p) => !isMetaPage(p))
      .map((p) => [p.slug, p]),
  );

  const now = new Date();
  const params = request.nextUrl.searchParams;
  const slug = params.get('slug');

  if (slug) {
    if (!readablePages.has(slug)) {
      return NextResponse.json({ error: `Page "${slug}" not found` }, { status: 404 });
    }
    // 单页：带 `recent`，供审计面展开看支撑这条判定的原始证据。
    return NextResponse.json({ mastery: deriveMastery(listForPage(userId, subjectId, slug), now) });
  }

  const evidenceBySlug = listForSubject(userId, subjectId);

  // 复习清单：`mastered` 本身已排除过期项，所以这就是 dueAt <= now < expiresAt 的窗口。
  // 它与全量分支共用同一次 listForSubject 与同一个 deriveMastery，只多一步过滤与排序。
  if (params.get('due') === '1') {
    const due: MasteryDueEntry[] = [];
    for (const [pageSlug, rows] of evidenceBySlug) {
      const page = readablePages.get(pageSlug);
      // 证据指向已删页：跳过（deriveMastery 不感知页面存在性，与另两条分支同口径）。
      if (!page) continue;
      const v = deriveMastery(rows, now);
      if (!isDueForReview(v, now)) continue;
      due.push({
        slug: pageSlug,
        title: page.title,
        dueAt: v.dueAt!,
        expiresAt: v.expiresAt!,
        confidence: v.confidence,
      });
    }
    // 最该复习的在前。
    due.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));

    const result: MasteryDueResult = {
      entries: due.slice(0, DUE_LIMIT),
      total: due.length,
      limit: DUE_LIMIT,
    };
    return NextResponse.json(result);
  }

  // 全量：**刻意不带 `recent`**。图层只需要着色所需的 state/confidence，逐页塞进
  // 最多 MAX_RECENT_EVIDENCE 条证据会让响应体随使用量线性膨胀，而其中 99% 永远不会
  // 被展开看。证据明细在 tap 节点时按单页取。
  const masteryBySlug: Record<string, MasteryVerdictLite> = {};
  for (const [pageSlug, rows] of evidenceBySlug) {
    if (!readablePages.has(pageSlug)) continue;
    const { recent, ...lite } = deriveMastery(rows, now);
    void recent;
    masteryBySlug[pageSlug] = lite;
  }

  return NextResponse.json({ masteryBySlug });
}
