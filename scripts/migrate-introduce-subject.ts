/**
 * One-shot migration that finalizes first-class wiki subjects.
 *
 * Usage:
 *   npm run db:migrate-subjects
 *
 * Environment:
 *   DATABASE_PATH   SQLite database file. Defaults to ./data/wiki.db
 *   VAULT_PATH      Git-backed vault root. Defaults to ./data/vault
 *
 * What it does (idempotent — safe to run multiple times):
 *   1. Snapshot the SQLite DB to <db>.bak.<ISO timestamp>.
 *   2. Rebuild the legacy `subjects` schema (`key` → `slug`, drop icon/color/
 *      is_default/archived_at) when present, and ensure a `general` row exists.
 *   3. For every top-level subdirectory under `vault/wiki/`, ensure a matching
 *      `subjects` row.
 *   4. Run the same column/PK migrations that `client.ts::ensureTables`
 *      performs for pages / page_aliases / wiki_links / sources / page_sources
 *      / jobs / job_events / operations / pages_fts.
 *   5. `git mv` any flat `wiki/*.md`, `raw/<source>` and `.llm-wiki/sources/*.json`
 *      files into their `general/` subdirectory and commit once.
 *   6. Synchronise `pages.path` so every row matches `wiki/<subject>/<slug>.md`.
 *
 * Important: stop the worker process before running. The script must own the
 * SQLite file alone while it rewrites tables.
 *
 * Implementation note: this file deliberately does NOT import from `src/server`.
 * The app DB bootstrap queries `subjects.slug`, which does not yet exist on the
 * legacy schema this script converts.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';

type Db = Database.Database;

interface ColumnInfo {
  name: string;
}

const GENERAL_SUBJECT_ID = 'subject-general';
const GENERAL_SUBJECT_SLUG = 'general';
const RAW_EXTENSIONS = new Set(['.md', '.html', '.pdf', '.txt']);
const VALID_SUBJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MIGRATION_PATH_PREFIXES = ['wiki/', 'raw/', '.llm-wiki/sources/'];

let sessionBackupPath: string | null = null;

function loadEnvFile(): void {
  try {
    const proc = process as NodeJS.Process & {
      loadEnvFile?: (path?: string) => void;
    };
    proc.loadEnvFile?.();
  } catch {
    // Best-effort. Real deployments can provide env directly.
  }
}

function resolvePathFromEnv(value: string | undefined, fallback: string): string {
  return path.resolve(process.cwd(), value ?? fallback);
}

function isoTimestamp(): string {
  return new Date().toISOString();
}

function logStep(step: string, message: string): void {
  console.log(`[${step}] ${message}`);
}

function abort(message: string): never {
  throw new Error(message);
}

async function backupDatabase(dbPath: string): Promise<string> {
  if (sessionBackupPath) return sessionBackupPath;
  if (!fs.existsSync(dbPath)) {
    abort(`Database file does not exist: ${dbPath}`);
  }

  const backupPath = `${dbPath}.bak.${isoTimestamp()}`;
  let db: Db | null = null;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    db.pragma('busy_timeout = 0');
    await db.backup(backupPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    abort(
      `Could not create SQLite backup. The database may be locked. ` +
        `Stop app/worker processes and retry. Details: ${message}`
    );
  } finally {
    db?.close();
  }

  sessionBackupPath = backupPath;
  return backupPath;
}

function openDatabase(dbPath: string): Db {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF');
  return db;
}

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return Boolean(row);
}

function tableColumns(db: Db, table: string): string[] {
  if (!tableExists(db, table)) return [];
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table) as ColumnInfo[];
  return rows.map((row) => row.name);
}

function primaryKeyColumns(db: Db, table: string): string[] {
  if (!tableExists(db, table)) return [];
  const rows = db
    .prepare(`SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`)
    .all(table) as Array<{ name: string; pk: number }>;
  return rows.map((row) => row.name);
}

function scalarCount(db: Db, sql: string, params: unknown[] = []): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function titleFromSlug(slug: string): string {
  return (
    slug
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || slug
  );
}

function ensureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function toGitPath(...parts: string[]): string {
  return parts.join('/');
}

function pathExistsForMove(filePath: string): boolean {
  // lstatSync: symlinks count as existing even when the target is missing.
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isMovableDirent(entry: fs.Dirent): boolean {
  return entry.isFile() || entry.isSymbolicLink();
}

function isMigrationPath(filePath: string): boolean {
  return MIGRATION_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function firstLevelWikiDirs(vaultPath: string): string[] {
  const wikiDir = path.join(vaultPath, 'wiki');
  if (!fs.existsSync(wikiDir)) return [];

  const slugs = fs
    .readdirSync(wikiDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  for (const slug of slugs) {
    if (!VALID_SUBJECT_SLUG_RE.test(slug)) {
      abort(
        `Invalid subject directory name "${slug}" under vault/wiki/. ` +
          `Expected kebab-case slug matching ${VALID_SUBJECT_SLUG_RE}.`
      );
    }
  }

  return slugs;
}

function migrateSubjectsTable(db: Db): boolean {
  if (!tableExists(db, 'subjects')) {
    db.exec(`
      CREATE TABLE subjects (
        id TEXT PRIMARY KEY NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    return false;
  }

  const cols = tableColumns(db, 'subjects');
  const isLegacy = cols.includes('key') && !cols.includes('slug');
  if (!isLegacy) return false;

  db.exec(`
    DROP TABLE IF EXISTS subjects_new;
    CREATE TABLE subjects_new (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO subjects_new (id, slug, name, description, created_at, updated_at)
    SELECT id, key, name, '', created_at, updated_at FROM subjects;

    DROP TABLE subjects;
    ALTER TABLE subjects_new RENAME TO subjects;
  `);

  return true;
}

function ensureGeneralSubject(db: Db): string {
  const existing = db
    .prepare(`SELECT id FROM subjects WHERE slug = ?`)
    .get(GENERAL_SUBJECT_SLUG) as { id: string } | undefined;
  if (existing) return existing.id;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
     VALUES (?, ?, 'General', '', ?, ?)`
  ).run(GENERAL_SUBJECT_ID, GENERAL_SUBJECT_SLUG, now, now);
  return GENERAL_SUBJECT_ID;
}

function ensureSubjectsForWikiDirs(db: Db, vaultPath: string): string[] {
  const inserted: string[] = [];
  const now = new Date().toISOString();

  for (const slug of firstLevelWikiDirs(vaultPath)) {
    const existing = db
      .prepare(`SELECT 1 FROM subjects WHERE slug = ?`)
      .get(slug);
    if (existing) continue;

    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`
    ).run(`subject-${randomUUID()}`, slug, titleFromSlug(slug), now, now);
    inserted.push(slug);
  }

  return inserted;
}

function migratePages(db: Db, generalId: string): void {
  if (!tableExists(db, 'pages')) {
    db.exec(`
      CREATE TABLE pages (
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        summary TEXT DEFAULT '',
        content_hash TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (subject_id, slug)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pages_path_unique ON pages(path);
    `);
    return;
  }

  const cols = tableColumns(db, 'pages');
  const hasSubjectId = cols.includes('subject_id');
  const pkCols = primaryKeyColumns(db, 'pages');
  const pkIsComposite =
    pkCols.length === 2 && pkCols[0] === 'subject_id' && pkCols[1] === 'slug';

  if (hasSubjectId && pkIsComposite) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS pages_path_unique ON pages(path);`);
    return;
  }

  db.exec(`
    DROP TABLE IF EXISTS pages_new;
    CREATE TABLE pages_new (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      summary TEXT DEFAULT '',
      content_hash TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, slug)
    );
  `);
  if (hasSubjectId) {
    db.prepare(
      `INSERT INTO pages_new (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at)
       SELECT COALESCE(subject_id, ?), slug, title, path, summary, content_hash, tags, created_at, updated_at FROM pages`
    ).run(generalId);
  } else {
    db.prepare(
      `INSERT INTO pages_new (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at)
       SELECT ?, slug, title, path, summary, content_hash, tags, created_at, updated_at FROM pages`
    ).run(generalId);
  }
  db.exec(`
    DROP TABLE pages;
    ALTER TABLE pages_new RENAME TO pages;
    CREATE UNIQUE INDEX IF NOT EXISTS pages_path_unique ON pages(path);
  `);
}

function migratePageAliases(db: Db, generalId: string): void {
  if (!tableExists(db, 'page_aliases')) {
    db.exec(`
      CREATE TABLE page_aliases (
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        old_slug TEXT NOT NULL,
        new_slug TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (subject_id, old_slug, new_slug)
      );
    `);
    return;
  }

  const cols = tableColumns(db, 'page_aliases');
  if (cols.includes('subject_id')) return;

  db.exec(`
    DROP TABLE IF EXISTS page_aliases_new;
    CREATE TABLE page_aliases_new (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      old_slug TEXT NOT NULL,
      new_slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, old_slug, new_slug)
    );
  `);
  db.prepare(
    `INSERT INTO page_aliases_new (subject_id, old_slug, new_slug, created_at)
     SELECT ?, old_slug, new_slug, created_at FROM page_aliases`
  ).run(generalId);
  db.exec(`
    DROP TABLE page_aliases;
    ALTER TABLE page_aliases_new RENAME TO page_aliases;
  `);
}

function migrateWikiLinks(db: Db, generalId: string): void {
  if (!tableExists(db, 'wiki_links')) {
    db.exec(`
      CREATE TABLE wiki_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        source_slug TEXT NOT NULL,
        target_subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
        target_slug TEXT NOT NULL,
        context TEXT DEFAULT ''
      );
    `);
    return;
  }

  const cols = tableColumns(db, 'wiki_links');
  if (cols.includes('subject_id') && cols.includes('target_subject_id')) return;

  db.exec(`
    DROP TABLE IF EXISTS wiki_links_new;
    CREATE TABLE wiki_links_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      source_slug TEXT NOT NULL,
      target_subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
      target_slug TEXT NOT NULL,
      context TEXT DEFAULT ''
    );
  `);

  if (cols.includes('subject_id')) {
    db.exec(`
      INSERT INTO wiki_links_new (subject_id, source_slug, target_subject_id, target_slug, context)
      SELECT subject_id, source_slug, subject_id, target_slug, context FROM wiki_links;
    `);
  } else {
    db.prepare(
      `INSERT INTO wiki_links_new (subject_id, source_slug, target_subject_id, target_slug, context)
       SELECT ?, source_slug, ?, target_slug, context FROM wiki_links`
    ).run(generalId, generalId);
  }

  db.exec(`
    DROP TABLE wiki_links;
    ALTER TABLE wiki_links_new RENAME TO wiki_links;
  `);
}

function migrateSources(db: Db, generalId: string): number {
  if (!tableExists(db, 'sources')) {
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
        filename TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        parsed_at TEXT,
        metadata_json TEXT DEFAULT '{}'
      );
    `);
    return 0;
  }

  const cols = tableColumns(db, 'sources');
  if (cols.includes('subject_id')) return 0;

  const rowCount = scalarCount(db, `SELECT COUNT(*) AS n FROM sources`);
  db.exec(`
    DROP TABLE IF EXISTS sources_new;
    CREATE TABLE sources_new (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
      filename TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parsed_at TEXT,
      metadata_json TEXT DEFAULT '{}'
    );
  `);
  db.prepare(
    `INSERT INTO sources_new (id, subject_id, filename, content_hash, parsed_at, metadata_json)
     SELECT id, ?, filename, content_hash, parsed_at, metadata_json FROM sources`
  ).run(generalId);
  db.exec(`
    DROP TABLE sources;
    ALTER TABLE sources_new RENAME TO sources;
  `);

  return rowCount;
}

function migratePageSources(db: Db, generalId: string): void {
  if (!tableExists(db, 'page_sources')) {
    db.exec(`
      CREATE TABLE page_sources (
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        page_slug TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY (subject_id, page_slug, source_id)
      );
    `);
    return;
  }

  const cols = tableColumns(db, 'page_sources');
  if (cols.includes('subject_id')) return;

  db.exec(`
    DROP TABLE IF EXISTS page_sources_new;
    CREATE TABLE page_sources_new (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      page_slug TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (subject_id, page_slug, source_id)
    );
  `);
  db.prepare(
    `INSERT INTO page_sources_new (subject_id, page_slug, source_id)
     SELECT ?, page_slug, source_id FROM page_sources`
  ).run(generalId);
  db.exec(`
    DROP TABLE page_sources;
    ALTER TABLE page_sources_new RENAME TO page_sources;
  `);
}

function migrateJobs(db: Db, generalId: string): void {
  if (!tableExists(db, 'jobs')) {
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
        params_json TEXT DEFAULT '{}',
        result_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER DEFAULT 0
      );
    `);
    return;
  }

  for (const [col, type] of [
    ['subject_id', 'TEXT REFERENCES subjects(id) ON DELETE SET NULL'],
    ['lease_expires_at', 'TEXT'],
    ['heartbeat_at', 'TEXT'],
    ['attempt_count', 'INTEGER DEFAULT 0'],
  ] as const) {
    const cols = tableColumns(db, 'jobs');
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${type}`);
    }
  }

  db.prepare(`UPDATE jobs SET subject_id = ? WHERE subject_id IS NULL`).run(generalId);
}

function migrateJobEvents(db: Db): void {
  if (tableExists(db, 'job_events')) return;
  db.exec(`
    CREATE TABLE job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function migrateOperations(db: Db, generalId: string): void {
  if (!tableExists(db, 'operations')) {
    db.exec(`
      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
        pre_head TEXT NOT NULL,
        post_head TEXT,
        changeset_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `);
    return;
  }

  const cols = tableColumns(db, 'operations');
  if (!cols.includes('subject_id')) {
    db.exec(
      `ALTER TABLE operations ADD COLUMN subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL`
    );
  }

  db.prepare(`UPDATE operations SET subject_id = ? WHERE subject_id IS NULL`).run(generalId);
}

function ensurePagesFts(db: Db): boolean {
  const ftsExists = tableExists(db, 'pages_fts');
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title, summary, body, subject_id UNINDEXED, slug UNINDEXED
      );
    `);
    return false;
  }

  const cols = tableColumns(db, 'pages_fts');
  if (cols.includes('subject_id')) return false;

  db.exec(`
    DROP TABLE pages_fts;
    CREATE VIRTUAL TABLE pages_fts USING fts5(
      title, summary, body, subject_id UNINDEXED, slug UNINDEXED
    );
  `);
  return true;
}

function detectedSubjects(db: Db): string[] {
  const rows = db
    .prepare(`SELECT slug FROM subjects ORDER BY slug ASC`)
    .all() as Array<{ slug: string }>;
  return rows.map((row) => row.slug);
}

async function gitMoveIfNeeded(
  git: SimpleGit,
  vaultPath: string,
  fromRel: string,
  toRel: string
): Promise<boolean> {
  const fromAbs = path.join(vaultPath, fromRel);
  const toAbs = path.join(vaultPath, toRel);

  if (!pathExistsForMove(fromAbs)) return false;
  if (pathExistsForMove(toAbs)) {
    abort(`Cannot move ${fromRel}: target already exists at ${toRel}`);
  }

  ensureDirectory(path.dirname(toAbs));

  try {
    await git.raw(['mv', fromRel, toRel]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not under version control/i.test(message)) throw error;
    // The source was untracked (e.g. files written outside a saga commit).
    // Fall back to a plain rename and stage the new path so the commit picks it up.
    fs.renameSync(fromAbs, toAbs);
    await git.add(toRel);
  }
  return true;
}

interface PlannedMove {
  fromRel: string;
  toRel: string;
}

function plannedVaultMoves(vaultPath: string): PlannedMove[] {
  return [
    ...flatWikiMarkdownFiles(vaultPath).map((file) => ({
      fromRel: toGitPath('wiki', file),
      toRel: toGitPath('wiki', GENERAL_SUBJECT_SLUG, file),
    })),
    ...flatRawSourceFiles(vaultPath).map((file) => ({
      fromRel: toGitPath('raw', file),
      toRel: toGitPath('raw', GENERAL_SUBJECT_SLUG, file),
    })),
    ...flatSourceMetadataFiles(vaultPath).map((file) => ({
      fromRel: toGitPath('.llm-wiki', 'sources', file),
      toRel: toGitPath('.llm-wiki', 'sources', GENERAL_SUBJECT_SLUG, file),
    })),
  ];
}

function preflightVaultLayout(vaultPath: string): void {
  for (const move of plannedVaultMoves(vaultPath)) {
    const fromAbs = path.join(vaultPath, move.fromRel);
    const toAbs = path.join(vaultPath, move.toRel);
    if (pathExistsForMove(fromAbs) && pathExistsForMove(toAbs)) {
      abort(
        `Cannot migrate vault layout: both ${move.fromRel} and ${move.toRel} exist. ` +
          `Resolve manually before re-running.`
      );
    }
  }
}

function assertNoActiveJobs(db: Db): void {
  if (!tableExists(db, 'jobs')) return;

  const cols = tableColumns(db, 'jobs');
  if (!cols.includes('lease_expires_at')) return;

  const activeJobs = scalarCount(
    db,
    `SELECT COUNT(*) AS n FROM jobs
     WHERE status = 'running'
       AND (lease_expires_at IS NULL OR lease_expires_at > ?)`,
    [new Date().toISOString()]
  );

  if (activeJobs > 0) {
    abort(
      `Refusing to migrate while ${activeJobs} running job(s) hold active leases. ` +
        `Stop the worker process and retry.`
    );
  }
}

function flatWikiMarkdownFiles(vaultPath: string): string[] {
  const wikiDir = path.join(vaultPath, 'wiki');
  if (!fs.existsSync(wikiDir)) return [];

  return fs
    .readdirSync(wikiDir, { withFileTypes: true })
    .filter((entry) => isMovableDirent(entry) && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function flatRawSourceFiles(vaultPath: string): string[] {
  const rawDir = path.join(vaultPath, 'raw');
  if (!fs.existsSync(rawDir)) return [];

  return fs
    .readdirSync(rawDir, { withFileTypes: true })
    .filter((entry) => {
      if (!isMovableDirent(entry)) return false;
      return RAW_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
    })
    .map((entry) => entry.name)
    .sort();
}

function flatSourceMetadataFiles(vaultPath: string): string[] {
  const sourcesDir = path.join(vaultPath, '.llm-wiki', 'sources');
  if (!fs.existsSync(sourcesDir)) return [];

  return fs
    .readdirSync(sourcesDir, { withFileTypes: true })
    .filter((entry) => isMovableDirent(entry) && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

async function migrateVaultLayout(vaultPath: string): Promise<number> {
  const git: SimpleGit = simpleGit({ baseDir: vaultPath });
  const changedPaths = new Set<string>();
  let movedCount = 0;

  ensureDirectory(path.join(vaultPath, 'wiki', GENERAL_SUBJECT_SLUG));
  ensureDirectory(path.join(vaultPath, 'raw', GENERAL_SUBJECT_SLUG));
  ensureDirectory(path.join(vaultPath, '.llm-wiki', 'sources', GENERAL_SUBJECT_SLUG));

  for (const move of plannedVaultMoves(vaultPath)) {
    const moved = await gitMoveIfNeeded(git, vaultPath, move.fromRel, move.toRel);
    if (!moved) continue;
    movedCount++;
    changedPaths.add(move.fromRel);
    changedPaths.add(move.toRel);
  }

  // Pick up paths that an earlier crashed run already staged so we still finish
  // the commit, but exclude unrelated user-staged work to keep the commit atomic.
  const stagedRaw = await git.raw(['diff', '--cached', '--name-only']);
  for (const line of stagedRaw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && isMigrationPath(trimmed)) changedPaths.add(trimmed);
  }

  if (changedPaths.size > 0) {
    await git.raw([
      'commit',
      '-m',
      'chore(subject): backfill subject directory layout',
      '--',
      ...changedPaths,
    ]);
  }

  return movedCount;
}

function stripSubjectPrefix(slug: string, subjectSlug: string): string | null {
  const prefix = `${subjectSlug}/`;
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : null;
}

interface SlugNormalisationStats {
  pages: number;
  pageAliases: number;
  pageSources: number;
  wikiLinks: number;
}

/**
 * Legacy DBs stored slugs with the subject directory baked in
 * ("general/foo") because pre-subject vault layout used flat paths. The new
 * subject-aware code expects the slug to be the leaf only ("foo"), with the
 * subject derived from the row's subject_id. Strip the redundant prefix from
 * every slug column we own so wiki routing, indexer lookups, and
 * cross-subject links all line up.
 */
function normaliseLegacySlugs(db: Db): SlugNormalisationStats {
  const stats: SlugNormalisationStats = {
    pages: 0,
    pageAliases: 0,
    pageSources: 0,
    wikiLinks: 0,
  };

  if (!tableExists(db, 'pages') || !tableExists(db, 'subjects')) return stats;

  const subjects = db
    .prepare(`SELECT id, slug FROM subjects`)
    .all() as Array<{ id: string; slug: string }>;
  const subjectSlugById = new Map(subjects.map((s) => [s.id, s.slug]));

  type PagesRow = { subject_id: string; slug: string };
  const pageRows = db.prepare(`SELECT subject_id, slug FROM pages`).all() as PagesRow[];
  const pageRenames: Array<{ subjectId: string; oldSlug: string; newSlug: string }> = [];
  for (const row of pageRows) {
    const subjectSlug = subjectSlugById.get(row.subject_id);
    if (!subjectSlug) continue;
    const stripped = stripSubjectPrefix(row.slug, subjectSlug);
    if (!stripped) continue;
    pageRenames.push({ subjectId: row.subject_id, oldSlug: row.slug, newSlug: stripped });
  }

  if (pageRenames.length === 0) return stats;

  const renamePage = db.prepare(
    `UPDATE pages SET slug = ? WHERE subject_id = ? AND slug = ?`,
  );
  const renamePageAlias = db.prepare(
    `UPDATE page_aliases SET old_slug = ? WHERE subject_id = ? AND old_slug = ?`,
  );
  const renamePageAliasNew = db.prepare(
    `UPDATE page_aliases SET new_slug = ? WHERE subject_id = ? AND new_slug = ?`,
  );
  const renamePageSource = db.prepare(
    `UPDATE page_sources SET page_slug = ? WHERE subject_id = ? AND page_slug = ?`,
  );
  const renameLinkSource = db.prepare(
    `UPDATE wiki_links SET source_slug = ? WHERE subject_id = ? AND source_slug = ?`,
  );
  const renameLinkTarget = db.prepare(
    `UPDATE wiki_links SET target_slug = ? WHERE target_subject_id = ? AND target_slug = ?`,
  );

  const tx = db.transaction(() => {
    for (const rename of pageRenames) {
      const { subjectId, oldSlug, newSlug } = rename;
      stats.pages += renamePage.run(newSlug, subjectId, oldSlug).changes;

      if (tableExists(db, 'page_aliases')) {
        stats.pageAliases += renamePageAlias.run(newSlug, subjectId, oldSlug).changes;
        stats.pageAliases += renamePageAliasNew.run(newSlug, subjectId, oldSlug).changes;
      }

      if (tableExists(db, 'page_sources')) {
        stats.pageSources += renamePageSource.run(newSlug, subjectId, oldSlug).changes;
      }

      if (tableExists(db, 'wiki_links')) {
        stats.wikiLinks += renameLinkSource.run(newSlug, subjectId, oldSlug).changes;
        stats.wikiLinks += renameLinkTarget.run(newSlug, subjectId, oldSlug).changes;
      }
    }
  });
  tx();

  return stats;
}

function syncPagePaths(db: Db): number {
  if (!tableExists(db, 'pages') || !tableExists(db, 'subjects')) return 0;

  type PagePathRow = {
    subject_id: string;
    subject_slug: string;
    slug: string;
    path: string;
  };

  const rows = db
    .prepare(
      `SELECT p.subject_id, s.slug AS subject_slug, p.slug, p.path
       FROM pages p
       JOIN subjects s ON s.id = p.subject_id`
    )
    .all() as PagePathRow[];

  const update = db.prepare(
    `UPDATE pages SET path = ? WHERE subject_id = ? AND slug = ?`
  );

  let updated = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const expectedPath = `wiki/${row.subject_slug}/${row.slug}.md`;
      if (row.path === expectedPath) continue;

      const result = update.run(expectedPath, row.subject_id, row.slug);
      updated += result.changes;
    }
  });
  tx();

  return updated;
}

async function main(): Promise<void> {
  loadEnvFile();

  const dbPath = resolvePathFromEnv(process.env.DATABASE_PATH, './data/wiki.db');
  const vaultPath = resolvePathFromEnv(process.env.VAULT_PATH, './data/vault');

  console.log('--- migrate-introduce-subject ---');
  console.log(`db   : ${dbPath}`);
  console.log(`vault: ${vaultPath}`);
  console.log('NOTE: stop the worker process before running.');

  const backupPath = await backupDatabase(dbPath);
  logStep('A', `backup created: ${backupPath}`);

  const db = openDatabase(dbPath);
  logStep('B', `database opened directly: ${dbPath}`);

  let subjectsTableRebuilt = false;
  let subjectsInsertedFromVault = 0;
  let sourcesBackfilled = 0;
  let ftsRecreated = false;
  let vaultFilesMoved = 0;
  let pagePathsUpdated = 0;
  let slugsNormalised: SlugNormalisationStats = {
    pages: 0,
    pageAliases: 0,
    pageSources: 0,
    wikiLinks: 0,
  };

  try {
    preflightVaultLayout(vaultPath);

    try {
      assertNoActiveJobs(db);

      // Single transactional boundary: either every table is migrated or none.
      // FTS5 virtual tables don't participate in WAL transactions cleanly, so
      // the FTS recreation runs separately at the end.
      const migrateSqlite = db.transaction(() => {
        subjectsTableRebuilt = migrateSubjectsTable(db);
        const generalId = ensureGeneralSubject(db);
        subjectsInsertedFromVault = ensureSubjectsForWikiDirs(db, vaultPath).length;

        migratePages(db, generalId);
        migratePageAliases(db, generalId);
        migrateWikiLinks(db, generalId);
        sourcesBackfilled = migrateSources(db, generalId);
        migratePageSources(db, generalId);
        migrateJobs(db, generalId);
        migrateJobEvents(db);
        migrateOperations(db, generalId);
      });
      migrateSqlite();

      ftsRecreated = ensurePagesFts(db);
    } finally {
      db.pragma('foreign_keys = ON');
    }
    logStep(
      'C',
      `sqlite migrated: subjects rebuilt=${subjectsTableRebuilt ? 'Y' : 'N'}, ` +
        `vault subjects inserted=${subjectsInsertedFromVault}, ` +
        `sources backfilled=${sourcesBackfilled}, fts recreated=${ftsRecreated ? 'Y' : 'N'}`
    );

    vaultFilesMoved = await migrateVaultLayout(vaultPath);
    logStep('D', `vault layout migrated: moved ${vaultFilesMoved} file(s)`);

    slugsNormalised = normaliseLegacySlugs(db);
    const slugStripTotal =
      slugsNormalised.pages +
      slugsNormalised.pageAliases +
      slugsNormalised.pageSources +
      slugsNormalised.wikiLinks;
    logStep(
      'E',
      `slug prefixes stripped: pages=${slugsNormalised.pages}, ` +
        `aliases=${slugsNormalised.pageAliases}, ` +
        `page_sources=${slugsNormalised.pageSources}, ` +
        `wiki_links=${slugsNormalised.wikiLinks} (total=${slugStripTotal})`,
    );

    pagePathsUpdated = syncPagePaths(db);
    logStep('F', `pages.path synchronised: updated ${pagePathsUpdated} row(s)`);

    const slugSummaryTotal =
      slugsNormalised.pages +
      slugsNormalised.pageAliases +
      slugsNormalised.pageSources +
      slugsNormalised.wikiLinks;
    const noWorkNeeded =
      !subjectsTableRebuilt &&
      subjectsInsertedFromVault === 0 &&
      sourcesBackfilled === 0 &&
      !ftsRecreated &&
      vaultFilesMoved === 0 &&
      pagePathsUpdated === 0 &&
      slugSummaryTotal === 0;

    const subjects = detectedSubjects(db);
    const subjectsDisplay = subjects.length > 5
      ? `${subjects.slice(0, 5).join(', ')}, … (+${subjects.length - 5})`
      : subjects.join(', ') || '(none)';

    logStep('G', noWorkNeeded ? 'final summary (already up to date)' : 'final summary');
    console.table([
      { metric: 'subjects table rebuilt?', value: subjectsTableRebuilt ? 'Y' : 'N' },
      { metric: 'subjects detected', value: `${subjects.length} total: ${subjectsDisplay}` },
      { metric: 'sources backfilled', value: sourcesBackfilled },
      { metric: 'vault files moved', value: vaultFilesMoved },
      { metric: 'pages.path rows updated', value: pagePathsUpdated },
      { metric: 'legacy slug prefixes stripped', value: slugSummaryTotal },
    ]);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[migrate-subjects] failed: ${message}`);
  process.exitCode = 1;
});
