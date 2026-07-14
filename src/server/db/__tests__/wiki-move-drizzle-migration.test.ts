import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let dir: string;
let sqlite: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wiki-move-drizzle-'));
  sqlite = new Database(join(dir, 'wiki.db'));
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function applyMigration(): void {
  const sql = readFileSync(
    resolve(process.cwd(), 'drizzle/0007_sturdy_valeria_richards.sql'),
    'utf-8',
  );
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

describe('0007 wiki.move migration', () => {
  it('保留 PendingAction 历史、接受 move，并把重复旧 slug alias 收敛为最新 canonical target', () => {
    sqlite.exec(`
      CREATE TABLE subjects (id TEXT PRIMARY KEY);
      CREATE TABLE conversations (id TEXT PRIMARY KEY);
      CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        applied_at TEXT,
        operation_id TEXT,
        job_id TEXT,
        error_json TEXT
      );
      CREATE TABLE page_aliases (
        subject_id TEXT NOT NULL,
        old_slug TEXT NOT NULL,
        new_slug TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (subject_id, old_slug, new_slug)
      );
      INSERT INTO subjects VALUES ('s1');
      INSERT INTO conversations VALUES ('c1');
      INSERT INTO pending_actions (
        id, conversation_id, subject_id, operation, payload_json, payload_hash,
        preview_json, status, created_at, updated_at, expires_at
      ) VALUES ('a1','c1','s1','delete','{}','h','{}','pending','t1','t1','t2');
      INSERT INTO page_aliases VALUES ('s1','old','first','t1');
      INSERT INTO page_aliases VALUES ('s1','old','latest','t2');
    `);

    applyMigration();

    expect(sqlite.prepare(`SELECT id, operation FROM pending_actions`).all())
      .toEqual([{ id: 'a1', operation: 'delete' }]);
    expect(() => sqlite.prepare(`
      INSERT INTO pending_actions (
        id, conversation_id, subject_id, operation, payload_json, payload_hash,
        preview_json, status, created_at, updated_at, expires_at
      ) VALUES ('a2','c1','s1','move','{}','h','{}','pending','t1','t1','t2')
    `).run()).not.toThrow();
    expect(sqlite.prepare(`SELECT old_slug, new_slug FROM page_aliases`).all())
      .toEqual([{ old_slug: 'old', new_slug: 'latest' }]);
    expect(() => sqlite.prepare(
      `INSERT INTO page_aliases VALUES ('s1','old','third','t3')`,
    ).run()).toThrow(/UNIQUE/);
  });
});
