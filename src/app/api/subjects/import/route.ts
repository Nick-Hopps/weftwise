import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { SubjectError } from '@/server/db/repos/subjects-repo';
import { importSubjectArchive } from '@/server/subjects/subject-archive';
import { ArchiveError } from '@/server/subjects/subject-archive-core';

export const runtime = 'nodejs';

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/**
 * POST /api/subjects/import
 * multipart/form-data：`file`（导出 zip，必填）+ `slug`（可选，冲突时换名）。
 * 成功 201 { subject, stats }；slug 冲突 409 { code: 'slug-conflict' } 供前端换名重试。
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 });
  }
  if (file.size > MAX_ARCHIVE_BYTES) {
    return NextResponse.json({ error: 'Archive exceeds 200MB limit' }, { status: 413 });
  }
  const slugField = form.get('slug');
  const slugOverride = typeof slugField === 'string' && slugField.trim() !== ''
    ? slugField.trim()
    : undefined;

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await importSubjectArchive(buffer, { slugOverride });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ArchiveError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    }
    if (error instanceof SubjectError) {
      const status = error.code === 'invalid-slug' ? 400 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    throw error;
  }
}
