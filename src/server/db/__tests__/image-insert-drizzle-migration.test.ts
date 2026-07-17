import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let dir: string;
let sqlite: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'image-insert-drizzle-'));
  sqlite = new Database(join(dir, 'wiki.db'));
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function applyMigration(): void {
  const sql = readFileSync(
    resolve(process.cwd(), 'drizzle/0010_zippy_infant_terrible.sql'),
    'utf-8',
  );
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

describe('0010 workflow-image-insert-start migration', () => {
  it('保留旧 PendingAction 行和索引，并只放行新增 operation', () => {
    sqlite.exec(`
      CREATE TABLE subjects (id TEXT PRIMARY KEY);
      CREATE TABLE conversations (id TEXT PRIMARY KEY);
      CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('create','delete','workflow-research-start')),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL
          CHECK (status IN ('pending','approved','executing','applied','rejected','expired','failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        applied_at TEXT,
        operation_id TEXT,
        job_id TEXT,
        error_json TEXT
      );
      INSERT INTO subjects VALUES ('s1');
      INSERT INTO conversations VALUES ('c1');
      INSERT INTO pending_actions (
        id, conversation_id, subject_id, operation, payload_json, payload_hash,
        preview_json, status, created_at, updated_at, expires_at
      ) VALUES ('old-action','c1','s1','delete','{}','hash','{}','pending','t1','t1','t2');
    `);

    applyMigration();

    expect(sqlite.prepare(`SELECT id, operation FROM pending_actions`).all())
      .toEqual([{ id: 'old-action', operation: 'delete' }]);
    expect(() => sqlite.prepare(`
      INSERT INTO pending_actions (
        id, conversation_id, subject_id, operation, payload_json, payload_hash,
        preview_json, status, created_at, updated_at, expires_at
      ) VALUES ('image-action','c1','s1','workflow-image-insert-start','{}','hash','{}','pending','t1','t1','t2')
    `).run()).not.toThrow();
    expect(() => sqlite.prepare(`
      INSERT INTO pending_actions (
        id, conversation_id, subject_id, operation, payload_json, payload_hash,
        preview_json, status, created_at, updated_at, expires_at
      ) VALUES ('unknown-action','c1','s1','unknown','{}','hash','{}','pending','t1','t1','t2')
    `).run()).toThrow(/CHECK constraint failed/);
    const indexes = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'pending_actions_%'
      ORDER BY name
    `).all();
    expect(indexes).toEqual([
      { name: 'pending_actions_conversation_status_idx' },
      { name: 'pending_actions_status_expiry_idx' },
      { name: 'pending_actions_subject_status_expiry_idx' },
    ]);
  });
});
