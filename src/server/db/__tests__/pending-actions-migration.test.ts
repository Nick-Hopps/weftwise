import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let dbPath: string;
let previousDatabasePath: string | undefined;

function seedLegacyPendingActions(operation: string, withOldCheck: boolean): void {
  const sqlite = new Database(dbPath);
  const check = withOldCheck
    ? "CHECK (operation IN ('create','update','patch','delete','reenrich'))"
    : '';
  sqlite.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE subjects (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      augmentation_level TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY NOT NULL,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE pending_actions (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      operation TEXT NOT NULL ${check},
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
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
    INSERT INTO subjects VALUES (
      's1', 'general', 'General', '', 'standard',
      '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
    );
    INSERT INTO conversations VALUES (
      'c1', 's1', 'Conversation',
      '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z'
    );
  `);
  sqlite.prepare(`
    INSERT INTO pending_actions (
      id, conversation_id, subject_id, operation, payload_json, payload_hash,
      preview_json, status, created_at, updated_at, expires_at
    ) VALUES ('a1', 'c1', 's1', ?, '{}', 'hash', '{}', 'pending', ?, ?, ?)
  `).run(
    operation,
    '2026-07-13T00:00:00.000Z',
    '2026-07-13T00:00:00.000Z',
    '2026-07-13T00:30:00.000Z',
  );
  sqlite.close();
}

beforeEach(() => {
  previousDatabasePath = process.env.DATABASE_PATH;
  dir = mkdtempSync(join(tmpdir(), 'pending-actions-migration-'));
  dbPath = join(dir, 'wiki.db');
  process.env.DATABASE_PATH = dbPath;
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

describe('pending_actions CHECK 启动迁移', () => {
  it('保留旧历史行，接受两个新 operation，未知 operation 仍拒绝', async () => {
    seedLegacyPendingActions('patch', true);
    const { getRawDb } = await import('../client');
    const sqlite = getRawDb();

    expect(sqlite.prepare(`SELECT id, operation FROM pending_actions`).all())
      .toEqual([{ id: 'a1', operation: 'patch' }]);
    const insert = sqlite.prepare(`
      INSERT INTO pending_actions (
        id, conversation_id, subject_id, operation, payload_json, payload_hash,
        preview_json, status, created_at, updated_at, expires_at
      ) VALUES (?, 'c1', 's1', ?, '{}', 'hash', '{}', 'pending', ?, ?, ?)
    `);
    for (const [id, operation] of [
      ['a2', 'metadata-patch'],
      ['a3', 'link-ensure'],
    ] as const) {
      expect(() => insert.run(id, operation, now(), now(), expires())).not.toThrow();
    }
    expect(() => insert.run('a4', 'unknown-operation', now(), now(), expires()))
      .toThrow(/CHECK constraint failed/);
  });

  it('copy 违反新 CHECK 时整个重建回滚，旧表和历史行保持不变', async () => {
    seedLegacyPendingActions('unknown-operation', false);
    const { getRawDb } = await import('../client');

    expect(() => getRawDb()).toThrow(/CHECK constraint failed/);

    const inspect = new Database(dbPath);
    expect(inspect.prepare(`SELECT id, operation FROM pending_actions`).all())
      .toEqual([{ id: 'a1', operation: 'unknown-operation' }]);
    expect(inspect.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_actions_new'`,
    ).get()).toBeUndefined();
    inspect.close();
  });
});

function now(): string {
  return '2026-07-13T00:00:00.000Z';
}

function expires(): string {
  return '2026-07-13T00:30:00.000Z';
}
