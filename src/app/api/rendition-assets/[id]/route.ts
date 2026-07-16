import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { getRenditionAsset } from '@/server/db/repos/renditions-repo';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const asset = getRenditionAsset(id);
  if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });

  return new NextResponse(Buffer.from(asset.dataBase64, 'base64') as unknown as BodyInit, {
    headers: {
      'Content-Type': asset.mediaType,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
