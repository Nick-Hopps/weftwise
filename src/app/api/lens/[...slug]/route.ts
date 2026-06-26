import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getPageBySlug } from '@/server/db/repos/pages-repo';
import { readPageInSubject } from '@/server/wiki/wiki-store';
import { getProfileOrDefault } from '@/server/db/repos/profiles-repo';
import { computeCanonicalHash } from '@/server/profile/rendition-hash';
import { getRendition, upsertRendition } from '@/server/db/repos/renditions-repo';
import { reshapePageBody } from '@/server/services/reshape-service';
import { isReshapeConfigured } from '@/server/llm/provider-registry';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;
  const userId = resolveUserId(request);

  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  const page = getPageBySlug(subject.id, slug);
  if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const doc = readPageInSubject(subject.slug, slug);
  const body = doc?.body ?? '';
  const profile = getProfileOrDefault(userId);
  const hash = computeCanonicalHash(body);

  const cached = getRendition(subject.id, slug, hash, profile.version);
  if (cached !== null) return NextResponse.json({ renderedMd: cached, source: 'cache' });

  if (!isReshapeConfigured()) return NextResponse.json({ renderedMd: body, source: 'canonical' });

  try {
    const result = await reshapePageBody({
      subject,
      body,
      profile: { backgroundSummary: profile.backgroundSummary, stylePrefs: profile.stylePrefs },
      abortSignal: request.signal,
    });
    if (result.fallback) return NextResponse.json({ renderedMd: body, source: 'fallback' });
    upsertRendition({
      subjectId: subject.id,
      slug,
      canonicalHash: hash,
      profileVersion: profile.version,
      renderedMd: result.body,
      model: result.model,
    });
    return NextResponse.json({ renderedMd: result.body, source: 'generated' });
  } catch {
    return NextResponse.json({ renderedMd: body, source: 'canonical' });
  }
}
