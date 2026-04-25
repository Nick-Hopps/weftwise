import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getRawDb } from '@/server/db/client';
import { vaultPath } from '@/server/config/env';
import { commitVaultChanges } from '@/server/git/git-service';
import { rebuildPageIndex } from '@/server/wiki/indexer';

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
    return resetAllSubjects(now);
  }

  const resolution = resolveSubjectFromRequest(request, { body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const wipe = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM page_sources WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM pages_fts WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM wiki_links WHERE subject_id = ? OR target_subject_id = ?`).run(subject.id, subject.id);
    sqlite.prepare(`DELETE FROM page_aliases WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM pages WHERE subject_id = ?`).run(subject.id);
    sqlite.prepare(`DELETE FROM sources WHERE subject_id = ?`).run(subject.id);
  });
  wipe();

  // Filesystem cleanup for this subject
  const subjectWikiDir = vaultPath('wiki', subject.slug);
  if (fs.existsSync(subjectWikiDir)) {
    fs.rmSync(subjectWikiDir, { recursive: true, force: true });
  }
  const subjectRawDir = vaultPath('raw', subject.slug);
  if (fs.existsSync(subjectRawDir)) {
    fs.rmSync(subjectRawDir, { recursive: true, force: true });
  }
  const subjectSidecarDir = vaultPath('.llm-wiki', 'sources', subject.slug);
  if (fs.existsSync(subjectSidecarDir)) {
    fs.rmSync(subjectSidecarDir, { recursive: true, force: true });
  }

  fs.mkdirSync(subjectWikiDir, { recursive: true });
  fs.writeFileSync(
    path.join(subjectWikiDir, 'index.md'),
    `---\ntitle: ${subject.name} — Index\ncreated: ${now}\nupdated: ${now}\ntags: [meta]\nsources: []\n---\n\n# ${subject.name}\n\nThis subject's index has been reset. Ingest a source to begin.\n`,
  );
  fs.writeFileSync(
    path.join(subjectWikiDir, 'log.md'),
    `---\ntitle: ${subject.name} — Change Log\ncreated: ${now}\nupdated: ${now}\ntags: [meta]\nsources: []\n---\n\n# Change Log\n\nAll changes to this subject are recorded here.\n`,
  );

  try {
    await commitVaultChanges(`[subject:${subject.slug}] Reset subject contents`);
  } catch {
    // git failure is non-fatal
  }

  rebuildPageIndex();

  return NextResponse.json({
    message: `Subject "${subject.slug}" has been reset`,
    subjectId: subject.id,
    timestamp: now,
  });
}

async function resetAllSubjects(now: string): Promise<NextResponse> {
  const sqlite = getRawDb();

  const wipe = sqlite.transaction(() => {
    sqlite.exec('DELETE FROM page_sources');
    sqlite.exec('DELETE FROM pages_fts');
    sqlite.exec('DELETE FROM wiki_links');
    sqlite.exec('DELETE FROM page_aliases');
    sqlite.exec('DELETE FROM pages');
    sqlite.exec('DELETE FROM sources');
    sqlite.exec('DELETE FROM job_events');
    sqlite.exec('DELETE FROM operations');
    sqlite.exec('DELETE FROM jobs');
    sqlite.exec(`DELETE FROM subjects WHERE slug != 'general'`);
  });
  wipe();

  const wikiDir = vaultPath('wiki');
  if (fs.existsSync(wikiDir)) {
    fs.rmSync(wikiDir, { recursive: true, force: true });
  }
  const rawDir = vaultPath('raw');
  if (fs.existsSync(rawDir)) {
    fs.rmSync(rawDir, { recursive: true, force: true });
  }
  const sourcesDir = vaultPath('.llm-wiki', 'sources');
  if (fs.existsSync(sourcesDir)) {
    fs.rmSync(sourcesDir, { recursive: true, force: true });
  }

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

  try {
    await commitVaultChanges('Reset wiki: cleared all subjects and ingested data');
  } catch {
    // git failure is non-fatal
  }

  rebuildPageIndex();

  return NextResponse.json({
    message: 'All ingested data has been cleared',
    timestamp: now,
  });
}
