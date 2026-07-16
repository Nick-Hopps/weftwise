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
import { isReshapeConfigured } from '@/server/llm/provider-registry';

export const runtime = 'nodejs';

interface LensContext {
  subject: NonNullable<ReturnType<typeof resolveSubjectFromRequest>['subject']>;
  slug: string;
  body: string;
  profile: ReturnType<typeof getProfileOrDefault>;
  canonicalHash: string;
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
  const profile = getProfileOrDefault(resolveUserId(request));
  return { subject, slug, body, profile, canonicalHash: computeCanonicalHash(body) };
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

  try {
    const result = await reshapePageBody({
      subject: context.subject,
      body: context.body,
      profile: {
        backgroundSummary: context.profile.backgroundSummary,
        stylePrefs: context.profile.stylePrefs,
      },
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
    return NextResponse.json({ renderedMd: result.body, source: 'generated', stale: false });
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: 'Reshape cancelled' }, { status: 499 });
    }
    console.error('[reshape] generation failed', error);
    return NextResponse.json({ error: 'Failed to reshape page' }, { status: 502 });
  }
}
