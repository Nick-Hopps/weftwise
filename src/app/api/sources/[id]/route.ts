import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import { deleteRawSourceFiles } from '@/server/sources/source-store';
import { commitVaultChanges } from '@/server/git/git-service';
import { acquireVaultLock } from '@/server/wiki/vault-mutex';

export const runtime = 'nodejs';

/**
 * DELETE /api/sources/[id] —— 删除孤儿 source（零 page_sources 关联才允许）。
 * vault 锁内：删 raw 文件 + sidecar（best-effort）→ 删 sources 行 → git commit。
 * 关联的 failed job 行不动（留着无害；reingest 端点靠 source 存在性校验兜底）。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const subject = resolution.subject;

  const { id } = await params;
  const source = sourcesRepo.getSource(id);
  if (!source || source.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  const unreferenced = sourcesRepo.listUnreferencedSources(subject.id).some((s) => s.id === id);
  if (!unreferenced) {
    return NextResponse.json({ error: 'already-referenced' }, { status: 409 });
  }

  const release = await acquireVaultLock();
  try {
    deleteRawSourceFiles(subject.slug, source.filename, source.id);
    sourcesRepo.deleteSource(source.id);
    await commitVaultChanges(`[subject:${subject.slug}] Delete orphan source ${source.filename}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to delete source: ${msg}` }, { status: 500 });
  } finally {
    release();
  }

  return NextResponse.json({ deleted: true });
}
