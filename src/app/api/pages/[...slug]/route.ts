import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { readPageInSubject } from '@/server/wiki/wiki-store';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import {
  applyChangeset,
  createChangeset,
  validateChangeset,
} from '@/server/wiki/wiki-transaction';
import { buildWikiPath } from '@/server/wiki/page-identity';

export const runtime = 'nodejs';

const UpdatePageSchema = z.object({
  content: z.string().min(1),
});

const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);

/**
 * GET /api/pages/<...slug>
 * Reads a page within the active subject.
 *
 * On 404 within the active subject we attempt to find the slug in any other
 * subject and return a hint so the UI can suggest "did you mean to switch?".
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  const page = pagesRepo.getPageBySlug(subject.id, slug);
  if (!page) {
    const elsewhere = pagesRepo.findPageBySlugAcrossSubjects(slug);
    return NextResponse.json(
      {
        error: 'Page not found',
        otherSubjects: elsewhere
          .filter((p) => p.subjectId !== subject.id)
          .map((p) => ({
            subjectId: p.subjectId,
            slug: p.slug,
            title: p.title,
          })),
      },
      { status: 404 }
    );
  }

  const doc = readPageInSubject(subject.slug, slug);
  const backlinks = pagesRepo.getBacklinks(subject.id, slug);

  return NextResponse.json({
    ...page,
    content: doc?.body ?? '',
    frontmatter: doc?.frontmatter ?? null,
    links: doc?.links ?? [],
    backlinks: backlinks.map((b) => ({
      slug: b.slug,
      title: b.title,
      subjectId: b.subjectId,
    })),
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const body = await request.json().catch(() => null);

  const resolution = resolveSubjectFromRequest(request, { body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  const existing = pagesRepo.getPageBySlug(subject.id, slug);
  if (!existing) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const parsed = UpdatePageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const changeset = createChangeset(crypto.randomUUID(), subject, [
    {
      action: 'update',
      path: buildWikiPath(subject.slug, slug),
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
  return NextResponse.json({ ok: true, slug, subjectId: subject.id });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const resolution = resolveSubjectFromRequest(request);
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  if (PROTECTED_SYSTEM_PAGES.has(slug)) {
    return NextResponse.json(
      { error: `Cannot delete protected system page "${slug}" in any subject` },
      { status: 400 },
    );
  }

  const existing = pagesRepo.getPageBySlug(subject.id, slug);
  if (!existing) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const changeset = createChangeset(crypto.randomUUID(), subject, [
    {
      action: 'delete',
      path: buildWikiPath(subject.slug, slug),
      content: null,
    },
  ]);

  await applyChangeset(changeset);
  return NextResponse.json({ ok: true, slug, subjectId: subject.id });
}
