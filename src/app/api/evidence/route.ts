import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getPageBySlug } from '@/server/db/repos/pages-repo';
import { appendEvidence } from '@/server/db/repos/evidence-repo';
import { EVIDENCE_KIND_META, type EvidenceKind } from '@/lib/contracts';

export const runtime = 'nodejs';

const EVIDENCE_KINDS = Object.keys(EVIDENCE_KIND_META) as [EvidenceKind, ...EvidenceKind[]];

const Body = z.object({
  slug: z.string().min(1),
  kind: z.enum(EVIDENCE_KINDS),
  anchor: z.string().optional(),
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

  try {
    appendEvidence({
      userId: resolveUserId(request),
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

  return NextResponse.json({ ok: true }, { status: 201 });
}
