import { NextRequest, NextResponse } from 'next/server';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { requireAuth } from '@/server/middleware/auth';
import { acquireVaultLock } from '@/server/wiki/vault-mutex';
import { exportSubjectArchive } from '@/server/subjects/subject-archive';

export const runtime = 'nodejs';

interface SubjectRouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/subjects/[id]/export
 * 导出 subject 为 zip（manifest + wiki/raw/assets/sources）。
 * 持 vault 锁读取，避免导出到 Saga 写入一半的状态。
 */
export async function GET(request: NextRequest, { params }: SubjectRouteContext) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const subject = subjectsRepo.getById(id);
  if (!subject) {
    return NextResponse.json({ error: 'Subject not found' }, { status: 404 });
  }

  const release = await acquireVaultLock();
  let buffer: Buffer;
  try {
    buffer = exportSubjectArchive(subject);
  } finally {
    release();
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${subject.slug}-export.zip"`,
      'Content-Length': String(buffer.length),
    },
  });
}
