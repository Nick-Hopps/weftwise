import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import * as schema from './schema';

type DrizzleDb = ReturnType<typeof createDb>;

let db: DrizzleDb | null = null;
let rawSqlite: Database.Database | null = null;

function createDb() {
  const dbPath = process.env.DATABASE_PATH || './data/wiki.db';

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  rawSqlite = sqlite;

  return drizzle(sqlite, { schema });
}

function ensureTables() {
  if (!rawSqlite) return;

  rawSqlite.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      summary TEXT DEFAULT '',
      content_hash TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS page_aliases (
      old_slug TEXT NOT NULL,
      new_slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (old_slug, new_slug)
    );

    CREATE TABLE IF NOT EXISTS wiki_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_slug TEXT NOT NULL,
      target_slug TEXT NOT NULL,
      context TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parsed_at TEXT,
      metadata_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS page_sources (
      page_slug TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (page_slug, source_id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      params_json TEXT DEFAULT '{}',
      result_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      attempt_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      pre_head TEXT NOT NULL,
      post_head TEXT,
      changeset_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );

  `);

  // Migrate: add lease/heartbeat/attempt columns to jobs table (safe on fresh DBs)
  for (const col of [
    ['lease_expires_at', 'TEXT'],
    ['heartbeat_at', 'TEXT'],
    ['attempt_count', 'INTEGER DEFAULT 0'],
  ] as const) {
    try {
      rawSqlite!.exec(`ALTER TABLE jobs ADD COLUMN ${col[0]} ${col[1]}`);
    } catch {
      // Column already exists
    }
  }

  // Create FTS5 table only if it doesn't exist — preserve existing search index
  const ftsExists = rawSqlite!.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pages_fts'"
  ).get();
  if (!ftsExists) {
    rawSqlite!.exec(`
      CREATE VIRTUAL TABLE pages_fts USING fts5(
        title, summary, body, slug UNINDEXED
      );
    `);
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
    // Initialize by calling getDb which sets rawSqlite as a side effect
    getDb();
  }
  if (!rawSqlite) {
    throw new Error('Failed to initialize SQLite database');
  }
  return rawSqlite;
}
