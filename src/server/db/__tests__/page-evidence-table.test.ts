import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

let dir: string;
let dbPath: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'page-evidence-'));
  dbPath = join(dir, 'wiki.db');
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('page_evidence 建表', () => {
  it('ensureTables 建出表与两个索引', async () => {
    const { getRawDb } = await import('../client');
    const db = getRawDb();

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain('page_evidence');

    const indices = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='page_evidence'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indices).toContain('page_evidence_page_idx');
    expect(indices).toContain('page_evidence_scope_idx');
  });

  it('subject_id FK CASCADE：删 subject 后证据行消失', async () => {
    const { getRawDb } = await import('../client');
    const subjectsRepo = await import('../repos/subjects-repo');
    const db = getRawDb();

    const subjectId = subjectsRepo.create({ slug: 'cascade-subj', name: 'S' }).id;
    db.prepare(
      `INSERT INTO page_evidence
         (user_id, subject_id, slug, kind, polarity, strength, anchor, detail_json, created_at)
       VALUES ('local', ?, 'p', 'quiz-correct', 'positive', 'strong', NULL, NULL, ?)`,
    ).run(subjectId, new Date().toISOString());

    const before = db
      .prepare(`SELECT COUNT(*) AS n FROM page_evidence WHERE subject_id = ?`)
      .get(subjectId) as { n: number };
    expect(before.n).toBe(1);

    // 直接删 subject 行，只让 FK 约束生效——不走 deleteWithContents 的显式清单，
    // 才能证明约束本身在兜底（「重建同名 subject 复活旧数据」那个坑的根因）。
    db.prepare(`DELETE FROM subjects WHERE id = ?`).run(subjectId);

    const after = db
      .prepare(`SELECT COUNT(*) AS n FROM page_evidence WHERE subject_id = ?`)
      .get(subjectId) as { n: number };
    expect(after.n).toBe(0);
  });
});

describe('user_profiles.style_prefs_updated_at', () => {
  it('新库建表即带该列', async () => {
    const { getRawDb } = await import('../client');
    const cols = (
      getRawDb().prepare(`PRAGMA table_info(user_profiles)`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(cols).toContain('style_prefs_updated_at');
  });

  it('既有安装（表已存在、无该列）升级后补上列', async () => {
    // `CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做。先手工造一个升级前形状的
    // user_profiles，再让 ensureTables 跑——没有守卫式 ALTER 的话这里就拿不到新列，
    // 而线上所有既有安装都是这个形状。
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE user_profiles (
        user_id TEXT PRIMARY KEY,
        background_summary TEXT NOT NULL DEFAULT '',
        style_prefs TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        onboarded_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO user_profiles (user_id, style_prefs, updated_at) VALUES ('local', '{}', ?)`,
      )
      .run(new Date().toISOString());
    legacy.close();

    const { getRawDb } = await import('../client');
    const db = getRawDb();

    const cols = (db.prepare(`PRAGMA table_info(user_profiles)`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toContain('style_prefs_updated_at');

    // 既有行保留，新列为 NULL（= 从未调过旋钮，reducer 消费全部历史证据）
    const row = db.prepare(`SELECT * FROM user_profiles WHERE user_id = 'local'`).get() as {
      style_prefs_updated_at: string | null;
    };
    expect(row.style_prefs_updated_at).toBeNull();
  });
});
