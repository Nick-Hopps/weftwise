import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getPageBySlug } from '@/server/db/repos/pages-repo';
import { readPageInSubject } from '@/server/wiki/wiki-store';
import { getProfileOrDefault } from '@/server/db/repos/profiles-repo';
import { computeCanonicalHash } from '@/server/profile/rendition-hash';
import { getLatestRendition, replaceRendition } from '@/server/db/repos/renditions-repo';
import { reshapePageBody } from '@/server/services/reshape-service';
import { buildKnownConceptsForPage, loadSubjectEvidence } from '@/server/profile/concept-map-io';
import { renderKnownConcepts, type KnownConcepts } from '@/server/profile/concept-map';
import { recordEvidence } from '@/server/services/record-evidence';
import { isReshapeConfigured } from '@/server/llm/provider-registry';

export const runtime = 'nodejs';

interface LensContext {
  subject: NonNullable<ReturnType<typeof resolveSubjectFromRequest>['subject']>;
  slug: string;
  body: string;
  userId: string;
  profile: ReturnType<typeof getProfileOrDefault>;
  canonicalHash: string;
}

/**
 * 算这一页的已知概念地图。**抛错按「无地图」继续**——重塑本身比地图重要，
 * 不该因为算不出地图就让读者拿不到重塑版。
 */
function buildMapSafely(context: LensContext): { concepts: KnownConcepts; rendered: string | null } | null {
  try {
    const { concepts, omitted } = buildKnownConceptsForPage({
      userId: context.userId,
      subject: context.subject,
      selfSlug: context.slug,
      body: context.body,
      evidenceBySlug: loadSubjectEvidence(context.userId, context.subject.id),
    });
    return { concepts, rendered: renderKnownConcepts(concepts, { omittedCount: omitted }) };
  } catch (error) {
    console.error('[lens] known-concept map failed; continuing without it', error);
    return null;
  }
}

async function resolveContext(
  request: NextRequest,
  params: Promise<{ slug: string[] }>,
): Promise<LensContext | NextResponse> {
  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  if (!getPageBySlug(subject.id, slug)) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  const body = readPageInSubject(subject.slug, slug)?.body ?? '';
  const userId = resolveUserId(request);
  const profile = getProfileOrDefault(userId);
  return { subject, slug, body, userId, profile, canonicalHash: computeCanonicalHash(body) };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const context = await resolveContext(request, params);
  if (context instanceof NextResponse) return context;

  const saved = getLatestRendition(context.subject.id, context.slug);
  if (!saved) {
    return NextResponse.json({ renderedMd: context.body, source: 'canonical', stale: false });
  }
  return NextResponse.json({
    renderedMd: saved.renderedMd,
    source: 'saved',
    stale:
      saved.canonicalHash !== context.canonicalHash ||
      saved.profileVersion !== context.profile.version,
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;
  const context = await resolveContext(request, params);
  if (context instanceof NextResponse) return context;
  if (!isReshapeConfigured()) {
    return NextResponse.json({ error: 'Reshape is not configured' }, { status: 503 });
  }

  const map = buildMapSafely(context);

  try {
    const result = await reshapePageBody({
      subject: context.subject,
      body: context.body,
      profile: {
        backgroundSummary: context.profile.backgroundSummary,
        stylePrefs: context.profile.stylePrefs,
      },
      knownConcepts: map?.rendered ?? null,
      abortSignal: request.signal,
    });
    replaceRendition({
      subjectId: context.subject.id,
      slug: context.slug,
      canonicalHash: context.canonicalHash,
      profileVersion: context.profile.version,
      renderedMd: result.body,
      model: result.model,
      assets: result.assets,
    });
    // D4：主动要求重塑本身就是「原文这样讲我没读顺」的弱信号。best-effort，
    // 失败不影响已经生成好的重塑版。
    recordEvidence({
      userId: context.userId,
      subjectId: context.subject.id,
      slug: context.slug,
      kind: 'reshape-request',
      detail: { profileVersion: context.profile.version },
    });
    return NextResponse.json({
      renderedMd: result.body,
      source: 'generated',
      stale: false,
      // 只有第一段（模型被明确告知「不必重讲」的那些）才挂纠错入口。
      assumedKnown: (map?.concepts.mastered ?? []).map((c) => c.slug),
    });
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: 'Reshape cancelled' }, { status: 499 });
    }
    console.error('[reshape] generation failed', error);
    return NextResponse.json({ error: 'Failed to reshape page' }, { status: 502 });
  }
}
