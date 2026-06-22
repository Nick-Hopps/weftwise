import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as operationsRepo from '@/server/db/repos/operations-repo';
import { getFileAtCommit } from '@/server/git/git-service';
import { buildRevertEntries } from '@/server/wiki/revert';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '@/server/wiki/wiki-transaction';
import { vaultPath } from '@/server/config/env';
import { parseWikiPath } from '@/server/wiki/page-identity';
import type { ChangesetEntry } from '@/lib/contracts';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { subject, error } = resolveSubjectFromRequest(request, { required: true, body });
  if (error) return error;

  const { id } = await params;
  const op = operationsRepo.getById(id);
  if (!op || op.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
  }
  if (op.status === 'reverted') {
    return NextResponse.json({ error: 'Operation already reverted' }, { status: 409 });
  }

  let original: ChangesetEntry[] = [];
  try {
    const parsed = JSON.parse(op.changesetJson);
    if (Array.isArray(parsed)) original = parsed as ChangesetEntry[];
  } catch {
    original = [];
  }

  // 预读受影响 path 在 preHead 的内容（getFileAtCommit 是 async，先汇总成同步可查的 Map）
  const uniquePaths = Array.from(new Set(original.map((e) => e.path)));
  const preHeadContent = new Map<string, string | null>();
  for (const p of uniquePaths) {
    try {
      preHeadContent.set(p, await getFileAtCommit(p, op.preHead));
    } catch {
      preHeadContent.set(p, null); // preHead 不存在该文件 → 操作新建了它 → 回滚删除
    }
  }

  const entries = buildRevertEntries(
    original,
    (p) => preHeadContent.get(p) ?? null,
    (p) => existsSync(vaultPath(p)),
  );

  const changeset = createChangeset(crypto.randomUUID(), subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    return NextResponse.json(
      { error: 'Revert validation failed', errors: validation.errors },
      { status: 422 },
    );
  }

  const applied = await applyChangeset(changeset);
  operationsRepo.markReverted(op.id);

  const affectedSlugs = entries.map((e) => parseWikiPath(e.path)?.slug ?? e.path);
  return NextResponse.json({
    revertedOperationId: op.id,
    newCommitSha: applied.postHead,
    affectedSlugs,
  });
}
