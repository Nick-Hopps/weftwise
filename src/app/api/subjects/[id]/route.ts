import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { SubjectError } from '@/server/db/repos/subjects-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { vaultPath } from '@/server/config/env';
import { commitVaultChanges } from '@/server/git/git-service';
import { AugmentationLevelSchema } from '@/lib/contracts';
import { acquireVaultLock } from '@/server/wiki/vault-mutex';
import {
  stageVaultPaths,
  VaultMaintenanceRestoreError,
} from '@/server/wiki/maintenance-files';

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

  const releaseVault = await acquireVaultLock();
  let staged: ReturnType<typeof stageVaultPaths> | null = null;
  let claim: subjectsRepo.SubjectMaintenanceClaim | null = null;
  let recoveryPending = false;
  try {
    // 先在 DB 内检查 active jobs / 入站引用并领取维护权，再移动任何目录。
    claim = subjectsRepo.beginDeleteMaintenance(id);
    const targets = [
      vaultPath('wiki', claim.slug),
      vaultPath('raw', claim.slug),
      vaultPath('.llm-wiki', 'sources', claim.slug),
    ];
    staged = stageVaultPaths(targets, {
      markerSubjectId: claim.id,
      expectedEpoch: claim.mutationEpoch,
      subjectIds: [claim.id],
    });
    subjectsRepo.deleteWithContents(id, {
      expectedMutationEpoch: claim.mutationEpoch,
    });
  } catch (err) {
    let failure = err;
    recoveryPending = err instanceof VaultMaintenanceRestoreError;
    try {
      if (!recoveryPending) staged?.restore();
    } catch (restoreError) {
      recoveryPending = true;
      failure = restoreError;
    } finally {
      try {
        // manifest 补偿尚未完成时保留 resetting + 旧 epoch，供启动恢复。
        if (claim && !recoveryPending) {
          subjectsRepo.cancelDeleteMaintenance(claim.id, claim.mutationEpoch);
        }
      } finally {
        releaseVault();
      }
    }
    if (failure instanceof SubjectError) {
      const status = failure.code === 'not-found' ? 404 : 409;
      return NextResponse.json({ error: failure.message, code: failure.code }, { status });
    }
    throw failure;
  }

  try {
    await commitVaultChanges(
      `[subject:${claim!.slug}] Delete subject and all contents`,
      [
        `wiki/${claim!.slug}`,
        `raw/${claim!.slug}`,
        `.llm-wiki/sources/${claim!.slug}`,
      ],
    );
  } catch {
    // git failure is non-fatal
  } finally {
    staged?.discard();
    releaseVault();
  }

  return NextResponse.json({ ok: true, subjectId: id });
}
