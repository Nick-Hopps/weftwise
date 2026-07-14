import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { readPageInSubject } from '@/server/wiki/wiki-store';
import { serializeWikiDocument } from '@/server/wiki/markdown';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import {
  applyChangeset,
  captureSubjectMutationEpoch,
  createChangeset,
  validateChangeset,
} from '@/server/wiki/wiki-transaction';
import { buildWikiPath } from '@/server/wiki/page-identity';
import { parseFrontmatter } from '@/server/wiki/frontmatter';
import { rewriteBacklinkText } from '@/server/wiki/relink';
import { enqueueEmbedIndex } from '@/server/services/embedding-service';
import { validateDeleteTarget } from '@/server/services/page-write';
import { executePageDelete } from '@/server/wiki/page-ops';
import type { ChangesetEntry } from '@/lib/contracts';

export const runtime = 'nodejs';

const UpdatePageSchema = z.object({
  content: z.string().min(1),
  refreshReferences: z.boolean().optional(),
});

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
    const canonicalSlug = pagesRepo.resolvePageAlias(subject.id, slug);
    if (canonicalSlug) {
      const target = new URL(request.url);
      target.pathname = `/api/pages/${canonicalSlug}`;
      return NextResponse.redirect(target, 308);
    }
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
    raw: doc ? serializeWikiDocument(doc) : '',
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
  const mutationEpoch = captureSubjectMutationEpoch(subject.id);

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

  const oldTitle = existing.title;
  const newTitle = parseFrontmatter(parsed.data.content).data.title;

  const entries: ChangesetEntry[] = [
    {
      action: 'update',
      path: buildWikiPath(subject.slug, slug),
      content: parsed.data.content,
    },
  ];

  // 标题变了且开启联动时，把本 subject 内以旧标题书写的引用一并重写进同一事务。
  let referencesUpdated = 0;
  const refresh = parsed.data.refreshReferences ?? true;
  if (refresh && newTitle && newTitle !== oldTitle) {
    const backlinks = pagesRepo
      .getBacklinks(subject.id, slug)
      .filter((b) => b.subjectId === subject.id && b.slug !== slug);
    for (const bl of backlinks) {
      const doc = readPageInSubject(subject.slug, bl.slug);
      if (!doc) continue;
      const sourceRaw = serializeWikiDocument(doc);
      const rewritten = rewriteBacklinkText(sourceRaw, oldTitle, newTitle, subject.slug);
      if (rewritten !== sourceRaw) {
        entries.push({
          action: 'update',
          path: buildWikiPath(subject.slug, bl.slug),
          content: rewritten,
        });
        referencesUpdated += 1;
      }
    }
  }

  const changeset = createChangeset(crypto.randomUUID(), subject, entries, mutationEpoch);

  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'Changeset validation failed', details: validation.errors },
      { status: 400 },
    );
  }

  await applyChangeset(changeset);
  // 写后触发向量回填（未配置 embedding 时 no-op）
  enqueueEmbedIndex(subject.id);
  return NextResponse.json({ ok: true, slug, subjectId: subject.id, referencesUpdated });
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

  const existing = pagesRepo.getPageBySlug(subject.id, slug);
  const validationError = validateDeleteTarget(slug, existing);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: existing ? 400 : 404 });
  }

  const { brokenBacklinks } = await executePageDelete(crypto.randomUUID(), subject, slug);
  // 删除后触发向量回填（prune 孤儿；未配置 embedding 时 no-op）
  enqueueEmbedIndex(subject.id);
  return NextResponse.json({ ok: true, slug, subjectId: subject.id, brokenBacklinks });
}
