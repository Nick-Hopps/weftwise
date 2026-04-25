import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import * as schema from './schema';

type DrizzleDb = ReturnType<typeof createDb>;

let db: DrizzleDb | null = null;
let rawSqlite: Database.Database | null = null;

function createDb() {
  const dbPath = process.env.DATABASE_PATH || './data/wiki.db';
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  rawSqlite = sqlite;
  return drizzle(sqlite, { schema });
}

interface ColumnInfo {
  name: string;
}

function tableColumns(table: string): string[] {
  const sqlite = rawSqlite!;
  const rows = sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as ColumnInfo[];
  return rows.map((r) => r.name);
}

function tableExists(table: string): boolean {
  const sqlite = rawSqlite!;
  const row = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(table);
  return Boolean(row);
}

function ensureSubjectsAndGeneral(): string {
  const sqlite = rawSqlite!;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const existing = sqlite
    .prepare(`SELECT id FROM subjects WHERE slug = 'general'`)
    .get() as { id: string } | undefined;
  if (existing) return existing.id;

  const id = randomUUID();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at)
       VALUES (?, 'general', 'General', '', ?, ?)`
    )
    .run(id, now, now);
  return id;
}

function migratePages(generalId: string): void {
  const sqlite = rawSqlite!;

  if (!tableExists('pages')) {
    sqlite.exec(`
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

  const cols = tableColumns('pages');
  if (cols.includes('subject_id')) return;

  sqlite.exec(`
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
  sqlite
    .prepare(
      `INSERT INTO pages_new (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at)
       SELECT ?, slug, title, path, summary, content_hash, tags, created_at, updated_at FROM pages`
    )
    .run(generalId);
  sqlite.exec(`
    DROP TABLE pages;
    ALTER TABLE pages_new RENAME TO pages;
    CREATE UNIQUE INDEX IF NOT EXISTS pages_path_unique ON pages(path);
  `);
}

function migratePageAliases(generalId: string): void {
  const sqlite = rawSqlite!;

  if (!tableExists('page_aliases')) {
    sqlite.exec(`
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

  const cols = tableColumns('page_aliases');
  if (cols.includes('subject_id')) return;

  sqlite.exec(`
    DROP TABLE IF EXISTS page_aliases_new;
    CREATE TABLE page_aliases_new (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      old_slug TEXT NOT NULL,
      new_slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, old_slug, new_slug)
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO page_aliases_new (subject_id, old_slug, new_slug, created_at)
       SELECT ?, old_slug, new_slug, created_at FROM page_aliases`
    )
    .run(generalId);
  sqlite.exec(`
    DROP TABLE page_aliases;
    ALTER TABLE page_aliases_new RENAME TO page_aliases;
  `);
}

function migrateWikiLinks(generalId: string): void {
  const sqlite = rawSqlite!;

  if (!tableExists('wiki_links')) {
    sqlite.exec(`
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

  const cols = tableColumns('wiki_links');
  if (cols.includes('subject_id') && cols.includes('target_subject_id')) return;

  sqlite.exec(`
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
  sqlite
    .prepare(
      `INSERT INTO wiki_links_new (subject_id, source_slug, target_subject_id, target_slug, context)
       SELECT ?, source_slug, ?, target_slug, context FROM wiki_links`
    )
    .run(generalId, generalId);
  sqlite.exec(`
    DROP TABLE wiki_links;
    ALTER TABLE wiki_links_new RENAME TO wiki_links;
  `);
}

function migrateSources(generalId: string): void {
  const sqlite = rawSqlite!;

  if (!tableExists('sources')) {
    sqlite.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
        filename TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        parsed_at TEXT,
        metadata_json TEXT DEFAULT '{}'
      );
    `);
    return;
  }

  const cols = tableColumns('sources');
  if (cols.includes('subject_id')) return;

  sqlite.exec(`
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
  sqlite
    .prepare(
      `INSERT INTO sources_new (id, subject_id, filename, content_hash, parsed_at, metadata_json)
       SELECT id, ?, filename, content_hash, parsed_at, metadata_json FROM sources`
    )
    .run(generalId);
  sqlite.exec(`
    DROP TABLE sources;
    ALTER TABLE sources_new RENAME TO sources;
  `);
}

function migratePageSources(generalId: string): void {
  const sqlite = rawSqlite!;

  if (!tableExists('page_sources')) {
    sqlite.exec(`
      CREATE TABLE page_sources (
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        page_slug TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY (subject_id, page_slug, source_id)
      );
    `);
    return;
  }

  const cols = tableColumns('page_sources');
  if (cols.includes('subject_id')) return;

  sqlite.exec(`
    DROP TABLE IF EXISTS page_sources_new;
    CREATE TABLE page_sources_new (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      page_slug TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (subject_id, page_slug, source_id)
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO page_sources_new (subject_id, page_slug, source_id)
       SELECT ?, page_slug, source_id FROM page_sources`
    )
    .run(generalId);
  sqlite.exec(`
    DROP TABLE page_sources;
    ALTER TABLE page_sources_new RENAME TO page_sources;
  `);
}

function migrateJobs(): void {
  const sqlite = rawSqlite!;

  if (!tableExists('jobs')) {
    sqlite.exec(`
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

  // Backfill any missing columns onto an existing table.
  for (const [col, type] of [
    ['subject_id', 'TEXT REFERENCES subjects(id) ON DELETE SET NULL'],
    ['lease_expires_at', 'TEXT'],
    ['heartbeat_at', 'TEXT'],
    ['attempt_count', 'INTEGER DEFAULT 0'],
  ] as const) {
    const cols = tableColumns('jobs');
    if (!cols.includes(col)) {
      try {
        sqlite.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${type}`);
      } catch {
        // Column already exists or alter not supported
      }
    }
  }
}

function migrateJobEvents(): void {
  const sqlite = rawSqlite!;
  if (tableExists('job_events')) return;
  sqlite.exec(`
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

function migrateOperations(): void {
  const sqlite = rawSqlite!;

  if (!tableExists('operations')) {
    sqlite.exec(`
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

  const cols = tableColumns('operations');
  if (!cols.includes('subject_id')) {
    try {
      sqlite.exec(
        `ALTER TABLE operations ADD COLUMN subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL`
      );
    } catch {
      // already exists
    }
  }
}

function ensurePagesFts(): void {
  const sqlite = rawSqlite!;
  const ftsExists = tableExists('pages_fts');
  if (!ftsExists) {
    sqlite.exec(`
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title, summary, body, subject_id UNINDEXED, slug UNINDEXED
      );
    `);
    return;
  }

  const cols = tableColumns('pages_fts');
  if (!cols.includes('subject_id')) {
    sqlite.exec(`DROP TABLE pages_fts;`);
    sqlite.exec(`
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title, summary, body, subject_id UNINDEXED, slug UNINDEXED
      );
    `);
  }
}

function ensureTables() {
  if (!rawSqlite) return;

  rawSqlite.pragma('foreign_keys = OFF');
  try {
    const generalId = ensureSubjectsAndGeneral();
    migratePages(generalId);
    migratePageAliases(generalId);
    migrateWikiLinks(generalId);
    migrateSources(generalId);
    migratePageSources(generalId);
    migrateJobs();
    migrateJobEvents();
    migrateOperations();
    ensurePagesFts();
  } finally {
    rawSqlite.pragma('foreign_keys = ON');
  }
}

export function getDb(): DrizzleDb {
  if (!db) {
    db = createDb();
    ensureTables();
  }
  return db;
}

export function getRawDb(): Database.Database {
  if (!rawSqlite) {
    getDb();
  }
  if (!rawSqlite) {
    throw new Error('Failed to initialize SQLite database');
  }
  return rawSqlite;
}
