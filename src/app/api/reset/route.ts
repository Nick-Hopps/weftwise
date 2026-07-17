import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getRawDb } from '@/server/db/client';
import { vaultPath } from '@/server/config/env';
import { commitVaultChanges } from '@/server/git/git-service';
import { rebuildPageIndex } from '@/server/wiki/indexer';
import { SubjectError } from '@/server/db/repos/subjects-repo';
import { acquireVaultLock } from '@/server/wiki/vault-mutex';
import {
  stageVaultPaths,
  VaultMaintenanceRestoreError,
} from '@/server/wiki/maintenance-files';

export const runtime = 'nodejs';

/**
 * POST /api/reset
 *
 * Body options:
 *   {} or { allSubjects: true }  → wipe everything, reseed with stub general subject
 *   { subjectId } / { subjectSlug } → reset only that subject (data + vault dirs)
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const body = await request.json().catch(() => null) as
    | { allSubjects?: boolean; subjectId?: string; subjectSlug?: string }
    | null;

  const allSubjects = body?.allSubjects === true;
  const now = new Date().toISOString();
  const sqlite = getRawDb();

  if (allSubjects || (!body?.subjectId && !body?.subjectSlug)) {
    try {
      return await resetAllSubjects(now);
    } catch (error) {
      return maintenanceErrorResponse(error);
    }
  }

  const resolution = resolveSubjectFromRequest(request, { body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const releaseVault = await acquireVaultLock();
  let maintenanceStarted = false;
  let recoveryPending = false;

  const beginReset = sqlite.transaction(() => {
    const current = sqlite.prepare(`
      SELECT maintenance_state FROM subjects WHERE id = ?
    `).get(subject.id) as { maintenance_state: string } | undefined;
    if (!current) {
      throw new SubjectError('not-found', 'Subject not found');
    }
    if (current.maintenance_state !== 'active') {
      throw new SubjectError('maintenance', 'Subject is already under maintenance');
    }
    const activeJob = sqlite.prepare(`
      SELECT id FROM jobs
      WHERE status IN ('pending', 'running')
        AND (subject_id = ? OR subject_id IS NULL)
      LIMIT 1
    `).get(subject.id);
    if (activeJob) {
      throw new SubjectError(
        'active-jobs',
        'Subject or global jobs are still active; wait for them before resetting',
      );
    }

    sqlite.prepare(`
      UPDATE subjects
      SET maintenance_state = 'resetting', updated_at = ?
      WHERE id = ?
    `).run(now, subject.id);
  });

  const purge = sqlite.transaction(() => {
    const current = sqlite.prepare(`
      SELECT maintenance_state FROM subjects WHERE id = ?
    `).get(subject.id) as { maintenance_state: string } | undefined;
    const activeJob = sqlite.prepare(`
      SELECT id FROM jobs
      WHERE status IN ('pending', 'running')
        AND (subject_id = ? OR subject_id IS NULL)
      LIMIT 1
    `).get(subject.id);
    if (!current || current.maintenance_state !== 'resetting') {
      throw new SubjectError('maintenance', 'Subject reset maintenance claim was lost');
    }
    if (activeJob) {
      throw new SubjectError(
        'active-jobs',
        'Subject or global jobs became active during reset',
      );
    }
    sqlite.prepare(`
      UPDATE subjects SET mutation_epoch = mutation_epoch + 1 WHERE id = ?
    `).run(subject.id);
    sqlite.prepare(`DELETE FROM research_candidate_ingests WHERE run_id IN (SELECT id FROM research_runs WHERE subject_id = ?)`).run(subject.id);
    sqlite.prepare(`DELETE FROM research_candidates WHERE run_id IN (SELECT id FROM research_runs WHERE subject_id = ?)`).run(subject.id);
    sqlite.prepare(`DELETE FROM research_approvals WHERE run_id IN (SELECT id FROM research_runs WHERE subject_id = ?)`).run(subject.id);
    sqlite.prepare(`DELETE FROM research_run_findings WHERE run_id IN (SELECT id FROM research_runs WHERE subject_id = ?)`).run(subject.id);
    sqlite.prepare(`DELETE FROM research_runs WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM page_sources WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM page_rendition_assets WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM page_renditions WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM page_maturity WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM page_embeddings WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM pages_fts WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM wiki_links WHERE subject_id = ? OR target_subject_id = ?`).run(subject.id, subject.id);
    sqlite.prepare(`DELETE FROM page_aliases WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM pages WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM sources WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM profile_signals WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM research_backlog WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM pending_actions WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = ?)`).run(subject.id);
    sqlite.prepare(`DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = ?)`).run(subject.id);
    sqlite.prepare(`DELETE FROM operations WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM jobs WHERE subject_id = ?`).run(subject.id);
    rebuildPageIndex();
  });
  try {
    beginReset.immediate();
    maintenanceStarted = true;
  } catch (error) {
    releaseVault();
    return maintenanceErrorResponse(error);
  }

  let staged: ReturnType<typeof stageVaultPaths> | null = null;
  try {
    const subjectWikiDir = vaultPath('wiki', subject.slug);
    const subjectRawDir = vaultPath('raw', subject.slug);
    const subjectSidecarDir = vaultPath('.llm-wiki', 'sources', subject.slug);
    const marker = sqlite.prepare(`
      SELECT mutation_epoch FROM subjects WHERE id = ?
    `).get(subject.id) as { mutation_epoch: number };
    staged = stageVaultPaths([subjectWikiDir, subjectRawDir, subjectSidecarDir], {
      markerSubjectId: subject.id,
      expectedEpoch: marker.mutation_epoch,
      subjectIds: [subject.id],
    });

    fs.mkdirSync(subjectWikiDir, { recursive: true });
    fs.writeFileSync(
      path.join(subjectWikiDir, 'index.md'),
      `---\ntitle: ${subject.name} — Index\ncreated: ${now}\nupdated: ${now}\ntags: [meta]\nsources: []\n---\n\n# ${subject.name}\n\nThis subject's index has been reset. Ingest a source to begin.\n`,
    );
    fs.writeFileSync(
      path.join(subjectWikiDir, 'log.md'),
      `---\ntitle: ${subject.name} — Change Log\ncreated: ${now}\nupdated: ${now}\ntags: [meta]\nsources: []\n---\n\n# Change Log\n\nAll changes to this subject are recorded here.\n`,
    );

    // DB purge 与从暂存后 vault 重建索引共用一个事务；失败即恢复旧目录。
    purge.immediate();

    try {
      await commitVaultChanges(
        `[subject:${subject.slug}] Reset subject contents`,
        [
          `wiki/${subject.slug}`,
          `raw/${subject.slug}`,
          `.llm-wiki/sources/${subject.slug}`,
        ],
      );
    } catch {
      // git failure is non-fatal
    }

    staged.discard();
  } catch (error) {
    let failure = error;
    recoveryPending = error instanceof VaultMaintenanceRestoreError;
    if (!recoveryPending && staged) {
      try {
        staged.restore();
      } catch (restoreError) {
        recoveryPending = true;
        failure = restoreError;
      }
    }
    if (!recoveryPending) {
      // purge 事务失败会回滚 epoch；失败路径仍提升一次，使维护前旧 lease 失效。
      bumpSubjectEpoch(subject.id);
    }
    return maintenanceErrorResponse(failure);
  } finally {
    try {
      // 补偿未完成时保留 resetting + 旧 epoch，由启动恢复读 manifest 决定。
      if (maintenanceStarted && !recoveryPending) restoreActiveSubject(subject.id, now);
    } finally {
      releaseVault();
    }
  }

  return NextResponse.json({
    message: `Subject "${subject.slug}" has been reset`,
    subjectId: subject.id,
    timestamp: now,
  });
}

async function resetAllSubjects(now: string): Promise<NextResponse> {
  const sqlite = getRawDb();
  const releaseVault = await acquireVaultLock();
  let maintenanceStarted = false;
  let recoveryPending = false;

  const beginReset = sqlite.transaction(() => {
    const activeJob = sqlite.prepare(`
      SELECT id FROM jobs WHERE status IN ('pending', 'running') LIMIT 1
    `).get();
    if (activeJob) {
      throw new SubjectError(
        'active-jobs',
        'Jobs are still active; wait for them before resetting all subjects',
      );
    }
    sqlite.prepare(`
      UPDATE subjects
      SET maintenance_state = 'resetting', updated_at = ?
    `).run(now);
  });

  const purge = sqlite.transaction(() => {
    const invalidState = sqlite.prepare(`
      SELECT id FROM subjects WHERE maintenance_state != 'resetting' LIMIT 1
    `).get();
    const activeJob = sqlite.prepare(`
      SELECT id FROM jobs WHERE status IN ('pending', 'running') LIMIT 1
    `).get();
    if (invalidState) {
      throw new SubjectError('maintenance', 'Global reset maintenance claim was lost');
    }
    if (activeJob) {
      throw new SubjectError('active-jobs', 'Jobs became active during global reset');
    }
    sqlite.exec(`UPDATE subjects SET mutation_epoch = mutation_epoch + 1`);
    sqlite.exec('DELETE FROM research_candidate_ingests');
    sqlite.exec('DELETE FROM research_candidates');
    sqlite.exec('DELETE FROM research_approvals');
    sqlite.exec('DELETE FROM research_run_findings');
    sqlite.exec('DELETE FROM research_runs');
    sqlite.exec('DELETE FROM page_sources');
    sqlite.exec('DELETE FROM page_rendition_assets');
    sqlite.exec('DELETE FROM page_renditions');
    sqlite.exec('DELETE FROM page_maturity');
    sqlite.exec('DELETE FROM page_embeddings');
    sqlite.exec('DELETE FROM pages_fts');
    sqlite.exec('DELETE FROM wiki_links');
    sqlite.exec('DELETE FROM page_aliases');
    sqlite.exec('DELETE FROM pages');
    sqlite.exec('DELETE FROM sources');
    sqlite.exec('DELETE FROM profile_signals');
    sqlite.exec('DELETE FROM research_backlog');
    sqlite.exec('DELETE FROM pending_actions');
    sqlite.exec('DELETE FROM job_events');
    sqlite.exec('DELETE FROM operations');
    sqlite.exec('DELETE FROM ingest_checkpoints');
    sqlite.exec('DELETE FROM jobs');
    sqlite.exec(`DELETE FROM subjects WHERE slug != 'general'`);
    rebuildPageIndex();
  });
  let staged: ReturnType<typeof stageVaultPaths> | null = null;
  try {
    beginReset.immediate();
    maintenanceStarted = true;
    const markers = sqlite.prepare(`
      SELECT id, mutation_epoch FROM subjects ORDER BY id
    `).all() as Array<{ id: string; mutation_epoch: number }>;
    const generalMarker = sqlite.prepare(`
      SELECT id, mutation_epoch FROM subjects WHERE slug = 'general'
    `).get() as { id: string; mutation_epoch: number };
    const wikiDir = vaultPath('wiki');
    const rawDir = vaultPath('raw');
    const sourcesDir = vaultPath('.llm-wiki', 'sources');
    staged = stageVaultPaths([wikiDir, rawDir, sourcesDir], {
      markerSubjectId: generalMarker.id,
      expectedEpoch: generalMarker.mutation_epoch,
      subjectIds: markers.map((marker) => marker.id),
    });

    // Reseed general subject's stub pages
    const generalDir = vaultPath('wiki', 'general');
    fs.mkdirSync(generalDir, { recursive: true });
    fs.writeFileSync(
      path.join(generalDir, 'index.md'),
      `---\ntitle: General — Index\ncreated: ${now}\nupdated: ${now}\ntags: [meta]\nsources: []\n---\n\n# Wiki Index\n\nWelcome to your LLM Wiki. Start by ingesting a source document.\n`,
    );
    fs.writeFileSync(
      path.join(generalDir, 'log.md'),
      `---\ntitle: General — Change Log\ncreated: ${now}\nupdated: ${now}\ntags: [meta]\nsources: []\n---\n\n# Change Log\n\nAll wiki changes are recorded here.\n`,
    );

    purge.immediate();

    try {
      await commitVaultChanges(
        'Reset wiki: cleared all subjects and ingested data',
        ['wiki', 'raw', '.llm-wiki/sources'],
      );
    } catch {
      // git failure is non-fatal
    }

    staged.discard();
  } catch (error) {
    let failure = error;
    recoveryPending = error instanceof VaultMaintenanceRestoreError;
    if (!recoveryPending && staged) {
      try {
        staged.restore();
      } catch (restoreError) {
        recoveryPending = true;
        failure = restoreError;
      }
    }
    if (!recoveryPending) {
      bumpAllSubjectEpochs();
    }
    throw failure;
  } finally {
    try {
      if (maintenanceStarted && !recoveryPending) restoreAllSubjectsActive(now);
    } finally {
      releaseVault();
    }
  }

  return NextResponse.json({
    message: 'All ingested data has been cleared',
    timestamp: now,
  });
}

function restoreAllSubjectsActive(now: string): void {
  getRawDb().prepare(`
    UPDATE subjects SET maintenance_state = 'active', updated_at = ?
  `).run(now);
}

function bumpSubjectEpoch(subjectId: string): void {
  getRawDb().prepare(`
    UPDATE subjects SET mutation_epoch = mutation_epoch + 1 WHERE id = ?
  `).run(subjectId);
}

function bumpAllSubjectEpochs(): void {
  getRawDb().exec(`UPDATE subjects SET mutation_epoch = mutation_epoch + 1`);
}

function restoreActiveSubject(subjectId: string, now: string): void {
  getRawDb().prepare(`
    UPDATE subjects
    SET maintenance_state = 'active', updated_at = ?
    WHERE id = ?
  `).run(now, subjectId);
}

function maintenanceErrorResponse(error: unknown): NextResponse {
  if (error instanceof SubjectError) {
    const status = error.code === 'not-found' ? 404 : 409;
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status },
    );
  }
  throw error;
}
