import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { SubjectError } from '@/server/db/repos/subjects-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { vaultPath } from '@/server/config/env';
import { commitVaultChanges } from '@/server/git/git-service';
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
  const subject = subjectsRepo.getById(id);
  if (!subject) {
    return NextResponse.json({ error: 'Subject not found' }, { status: 404 });
  }

  // 级联清理 DB（含守卫：general / 入站跨主题引用）。
  try {
    subjectsRepo.deleteWithContents(id);
  } catch (err) {
    if (err instanceof SubjectError) {
      const status = err.code === 'not-found' ? 404 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }

  // 清理该 subject 的 vault 子目录。
  for (const dir of [
    vaultPath('wiki', subject.slug),
    vaultPath('raw', subject.slug),
    vaultPath('.llm-wiki', 'sources', subject.slug),
  ]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  try {
    await commitVaultChanges(`[subject:${subject.slug}] Delete subject and all contents`);
  } catch {
    // git failure is non-fatal
  }

  return NextResponse.json({ ok: true, subjectId: id });
}
