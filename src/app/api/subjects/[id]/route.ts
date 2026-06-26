import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { SubjectError } from '@/server/db/repos/subjects-repo';
import { deleteBySubject as deleteRenditionsBySubject } from '@/server/db/repos/renditions-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { AugmentationLevelSchema } from '@/lib/contracts';

export const runtime = 'nodejs';

const PatchSubjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  augmentationLevel: AugmentationLevelSchema.optional(),
});

interface SubjectRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: SubjectRouteContext) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const subject = subjectsRepo.getById(id);
  if (!subject) {
    return NextResponse.json({ error: 'Subject not found' }, { status: 404 });
  }
  return NextResponse.json({
    ...subject,
    pageCount: subjectsRepo.countPages(subject.id),
  });
}

export async function PATCH(request: NextRequest, { params }: SubjectRouteContext) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = PatchSubjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const { augmentationLevel, ...renameFields } = parsed.data;
    let subject = subjectsRepo.getById(id);
    if (!subject) {
      return NextResponse.json({ error: 'Subject not found' }, { status: 404 });
    }
    if (renameFields.name !== undefined || renameFields.description !== undefined) {
      subject = subjectsRepo.rename(id, renameFields);
    }
    if (augmentationLevel !== undefined) {
      subject = subjectsRepo.setAugmentationLevel(id, augmentationLevel);
    }
    return NextResponse.json(subject);
  } catch (err) {
    if (err instanceof SubjectError) {
      const status = err.code === 'not-found' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}

export async function DELETE(request: NextRequest, { params }: SubjectRouteContext) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const { id } = await params;
  try {
    subjectsRepo.deleteIfEmpty(id);
    // 清理该 subject 残留的重塑缓存（含已删页遗留的孤儿 rendition）。
    deleteRenditionsBySubject(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SubjectError) {
      const status =
        err.code === 'not-found' ? 404 : err.code === 'not-empty' ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
