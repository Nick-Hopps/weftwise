import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { readPageBySlug } from '@/server/wiki/wiki-store';
import { requireAuth } from '@/server/middleware/auth';
import {
  applyChangeset,
  createChangeset,
  validateChangeset,
} from '@/server/wiki/wiki-transaction';
import { wikiPathFromSlug } from '@/server/wiki/page-identity';

export const runtime = 'nodejs';

const UpdatePageSchema = z.object({
  content: z.string().min(1),
});

const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);

/**
 * GET /api/pages/some-page
 * GET /api/pages/nested/page
 *
 * Returns full page metadata, body content, frontmatter, wikilinks, and backlinks.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  // 1. DB metadata
  const page = pagesRepo.getPageBySlug(slug);
  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  // 2. File-system content (WikiDocument)
  const doc = readPageBySlug(slug);

  // 3. Backlinks
  const backlinks = pagesRepo.getBacklinks(slug);

  // 4. Combined response
  return NextResponse.json({
    ...page,
    content: doc?.body ?? '',
    frontmatter: doc?.frontmatter ?? null,
    links: doc?.links ?? [],
    backlinks: backlinks.map((b) => ({ slug: b.slug, title: b.title })),
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  const existing = pagesRepo.getPageBySlug(slug);
  if (!existing) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const parsed = UpdatePageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const changeset = createChangeset(crypto.randomUUID(), [
    {
      action: 'update',
      path: wikiPathFromSlug(slug),
      content: parsed.data.content,
    },
  ]);

  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'Changeset validation failed', details: validation.errors },
      { status: 400 },
    );
  }

  await applyChangeset(changeset);
  return NextResponse.json({ ok: true, slug });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  if (PROTECTED_SYSTEM_PAGES.has(slug)) {
    return NextResponse.json(
      { error: `Cannot delete protected system page "${slug}"` },
      { status: 400 },
    );
  }

  const existing = pagesRepo.getPageBySlug(slug);
  if (!existing) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const changeset = createChangeset(crypto.randomUUID(), [
    {
      action: 'delete',
      path: wikiPathFromSlug(slug),
      content: null,
    },
  ]);

  await applyChangeset(changeset);
  return NextResponse.json({ ok: true, slug });
}
