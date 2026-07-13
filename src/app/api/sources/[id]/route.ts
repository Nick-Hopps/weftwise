import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import * as jobsRepo from '@/server/db/repos/jobs-repo';
import { deleteRawSourceFiles } from '@/server/sources/source-store';
import { commitVaultChanges } from '@/server/git/git-service';
import { acquireVaultLock } from '@/server/wiki/vault-mutex';

export const runtime = 'nodejs';

/**
 * DELETE /api/sources/[id] —— 删除孤儿 source（零 page_sources 关联才允许）。
 * 同源 ingest job 在途（pending/running）时 409 in-flight（对称于 reingest 端点）。
 * vault 锁内：删 raw 文件 + sidecar（best-effort）→ 删 sources 行 → git commit。
 * 关联的 failed job 行不动（留着无害）：源摄入的重试入口——本孤儿 source 专用的
 * `POST /api/sources/[id]/reingest` 与 ingest workbench 通用的 `POST /api/jobs/[id]/retry`——
 * 都会在 requeue 前校验 sourceId 对应的 source 行是否还在，删除后若被点击重试统一 409。
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

  // 同源 ingest job 在途时不允许删除（对称于 reingest 端点的 in-flight 守卫）：
  // 删除在途任务的 raw 文件会让 worker 读盘失败，甚至在 Saga 完成后插入指向已删 source 的悬挂 page_sources 行
  const job = jobsRepo.findLatestIngestJobForSource(subject.id, id);
  if (job && (job.status === 'pending' || job.status === 'running')) {
    return NextResponse.json({ error: 'in-flight' }, { status: 409 });
  }

  const release = await acquireVaultLock();
  try {
    deleteRawSourceFiles(subject.slug, source.filename, source.id);
    sourcesRepo.deleteSource(source.id);
    await commitVaultChanges(
      `[subject:${subject.slug}] Delete orphan source ${source.filename}`,
      [
        `raw/${subject.slug}/${source.filename}`,
        `.llm-wiki/sources/${subject.slug}/${source.id}.json`,
        `.llm-wiki/sources/${source.id}.json`,
      ],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to delete source: ${msg}` }, { status: 500 });
  } finally {
    release();
  }

  return NextResponse.json({ deleted: true });
}
