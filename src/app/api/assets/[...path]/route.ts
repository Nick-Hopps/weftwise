import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { readVaultAsset } from '@/server/wiki/wiki-store';

export const runtime = 'nodejs';

/** Read generated subject-scoped images referenced by enriched Markdown. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { path } = await params;
  if (path.length !== 2) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  const [subjectSlug, filename] = path;
  const subject = subjectsRepo.getBySlug(subjectSlug);
  if (!subject) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  const asset = readVaultAsset(subject.slug, filename);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  return new NextResponse(asset.data as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': asset.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
