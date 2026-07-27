import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getPageBySlug } from '@/server/db/repos/pages-repo';
import { appendEvidence } from '@/server/db/repos/evidence-repo';
import { EVIDENCE_KIND_META, STYLE_BEARING_EVIDENCE_KINDS, type EvidenceKind } from '@/lib/contracts';
import { learnStyleFromEvidence } from '@/server/services/style-learning';

export const runtime = 'nodejs';

const EVIDENCE_KINDS = Object.keys(EVIDENCE_KIND_META) as [EvidenceKind, ...EvidenceKind[]];

/**
 * 身份字段的大小上限。超限直接 400 而不是截断——它们参与页面/题目身份，
 * 截断出来的是一个**别的** slug，会静默把证据归到错的地方。
 * （审计字段 `detail` 走另一套：在 repo 层截断但不丢证据，见 `MAX_DETAIL_BYTES`。）
 */
const MAX_SLUG_CHARS = 512;
const MAX_ANCHOR_CHARS = 256;

const Body = z.object({
  slug: z.string().min(1).max(MAX_SLUG_CHARS),
  kind: z.enum(EVIDENCE_KINDS),
  anchor: z.string().max(MAX_ANCHOR_CHARS).optional(),
  /** 仅 `quiz-correct` 会被采纳；其余 kind 的权重由 kind 决定（见 evidence-repo）。 */
  strength: z.enum(['strong', 'weak']).optional(),
  /** 归因载荷：viewedSource / profileVersion 等，只用于事后审计。 */
  detail: z.unknown().optional(),
  // 供 resolveSubjectFromRequest 的 body 路径读取（zod 会剥掉未声明字段）。
  subjectId: z.string().optional(),
  subjectSlug: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid evidence' }, { status: 400 });
  }

  // required：证据必须归属到确定的 subject，不靠 cookie 兜底猜。
  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const subjectId = resolution.subject.id;

  // 写前存在性校验：没有它，陈旧客户端（页面刚被删/改名、缓存未刷新）会持续累积
  // 指向幽灵页的证据，而生命周期闭合只清理「存在过的页」，兜不住从未存在过的 slug。
  if (!getPageBySlug(subjectId, body.slug)) {
    return NextResponse.json({ error: `Page "${body.slug}" not found` }, { status: 404 });
  }

  const userId = resolveUserId(request);
  try {
    appendEvidence({
      userId,
      subjectId,
      slug: body.slug,
      kind: body.kind,
      anchor: body.anchor ?? null,
      strength: body.strength,
      detail: body.detail,
    });
  } catch (error) {
    console.error('[evidence] append failed', error);
    return NextResponse.json({ error: 'Failed to record evidence' }, { status: 500 });
  }

  // 只有「讲法」类证据才推动风格画像；掌握度类证据跑 reducer 纯属浪费，
  // 且白名单本就会把它们全滤掉。`style` 供客户端决定是否失效 lens 缓存。
  const style = STYLE_BEARING_EVIDENCE_KINDS.includes(body.kind)
    ? learnStyleFromEvidence(userId)
    : { changed: false, version: 0 };

  return NextResponse.json({ ok: true, style }, { status: 201 });
}
