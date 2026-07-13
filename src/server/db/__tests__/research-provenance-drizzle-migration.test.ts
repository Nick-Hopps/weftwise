import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let dir: string;
let previousDatabasePath: string | undefined;
let previousVaultPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'research-drizzle-migration-'));
  previousDatabasePath = process.env.DATABASE_PATH;
  previousVaultPath = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = previousDatabasePath;
  process.env.VAULT_PATH = previousVaultPath;
  rmSync(dir, { recursive: true, force: true });
});

function applyMigration(sqlite: Database.Database): void {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0004_tense_marvex.sql'),
    'utf-8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

function seedLegacyDatabase(sqlite: Database.Database): string {
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
    CREATE TABLE pages (
      subject_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE, summary TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, slug)
    );
    CREATE TABLE sources (
      id TEXT PRIMARY KEY NOT NULL,
      subject_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parsed_at TEXT,
      metadata_json TEXT DEFAULT '{}'
    );
    CREATE TABLE page_sources (
      subject_id TEXT NOT NULL,
      page_slug TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (subject_id, page_slug, source_id)
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      subject_id TEXT,
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
  const now = '2026-07-13T00:00:00.000Z';
  sqlite.prepare(`INSERT INTO subjects VALUES ('s1', 'general', 'General', '', 'standard', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO pages VALUES ('s1', 'p1', 'P1', 'wiki/general/p1.md', '', 'p-hash', '[]', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO sources VALUES ('source-a', 's1', 'a.md', 'same-hash', NULL, '{}')`).run();
  sqlite.prepare(`INSERT INTO sources VALUES ('source-z', 's1', 'a.md', 'same-hash', NULL, '{}')`).run();
  sqlite.prepare(`INSERT INTO page_sources VALUES ('s1', 'p1', 'source-z')`).run();
  sqlite.prepare(`INSERT INTO jobs (id, type, status, subject_id, params_json, created_at) VALUES ('j1', 'ingest', 'completed', 's1', ?, ?)`).run(
    JSON.stringify({ sourceId: 'source-z', subjectId: 's1' }),
    now,
  );
  const sidecarDir = join(dir, 'vault', '.llm-wiki', 'sources', 'general');
  mkdirSync(sidecarDir, { recursive: true });
  const loserSidecar = join(sidecarDir, 'source-z.json');
  writeFileSync(loserSidecar, '{}');
  return loserSidecar;
}

describe('0004 Research provenance migration', () => {
  it('稳定合并旧 source、迁移引用并在 worker 启动时提交 loser sidecar 补偿', async () => {
    const sqlite = new Database(process.env.DATABASE_PATH!);
    const loserSidecar = seedLegacyDatabase(sqlite);

    applyMigration(sqlite);
    sqlite.pragma('foreign_keys = ON');

    expect(sqlite.prepare(`SELECT id FROM sources ORDER BY id`).all()).toEqual([{ id: 'source-a' }]);
    expect(sqlite.prepare(`SELECT source_id FROM page_sources`).get()).toEqual({ source_id: 'source-a' });
    expect(JSON.parse((sqlite.prepare(`SELECT params_json FROM jobs WHERE id = 'j1'`).get() as { params_json: string }).params_json))
      .toMatchObject({ sourceId: 'source-a' });
    expect(sqlite.prepare(`SELECT loser_id, winner_id FROM source_dedup_cleanup`).all())
      .toEqual([{ loser_id: 'source-z', winner_id: 'source-a' }]);
    expect(() => sqlite.prepare(`INSERT INTO sources VALUES ('another', 's1', 'a.md', 'same-hash', NULL, '{}')`).run())
      .toThrow();
    const provenanceTables = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'research_runs', 'research_run_findings', 'research_candidates',
          'research_approvals', 'research_candidate_ingests'
        )
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(provenanceTables).toHaveLength(5);
    const indexes = sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
      'research_runs_research_job_id_unique',
      'research_runs_subject_status_updated_idx',
      'research_candidates_run_url_unique',
      'research_candidates_run_rank_idx',
      'research_approvals_run_unique',
      'research_candidate_ingests_ingest_job_unique',
      'research_candidate_ingests_status_lease_idx',
    ]));
    expect(() => sqlite.prepare(`
      INSERT INTO research_runs (
        id, subject_id, research_job_id, origin, candidate_set_hash, status,
        created_at, updated_at
      ) VALUES ('bad-run', 's1', 'bad-job', 'topic', 'hash', 'unknown', ?, ?)
    `).run('2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z')).toThrow();
    sqlite.close();

    const { getRawDb } = await import('../client');
    const upgraded = getRawDb();
    expect(existsSync(loserSidecar)).toBe(true);
    expect(upgraded.prepare(`SELECT loser_id FROM source_dedup_cleanup`).get())
      .toEqual({ loser_id: 'source-z' });
    await reconcileDedupSidecars(upgraded);
    expect(existsSync(loserSidecar)).toBe(false);
    expect(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_dedup_cleanup'`).get())
      .toBeUndefined();
  });

  it('client.ensureTables 可直接升级未执行 Drizzle migration 的重复 source 旧库', async () => {
    const sqlite = new Database(process.env.DATABASE_PATH!);
    const loserSidecar = seedLegacyDatabase(sqlite);
    sqlite.close();

    const { getRawDb } = await import('../client');
    const upgraded = getRawDb();

    expect(upgraded.prepare(`SELECT id FROM sources ORDER BY id`).all()).toEqual([{ id: 'source-a' }]);
    expect(upgraded.prepare(`SELECT source_id FROM page_sources`).get()).toEqual({ source_id: 'source-a' });
    expect(JSON.parse((upgraded.prepare(`SELECT params_json FROM jobs WHERE id = 'j1'`).get() as { params_json: string }).params_json))
      .toMatchObject({ sourceId: 'source-a' });
    expect(existsSync(loserSidecar)).toBe(true);
    await reconcileDedupSidecars(upgraded);
    expect(existsSync(loserSidecar)).toBe(false);
    expect(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sources_subject_hash_filename_unique'`).get())
      .toBeTruthy();
    expect(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_dedup_cleanup'`).get())
      .toBeUndefined();
  });

  it('client runtime migration 后续失败时整体回滚 DB 去重且不删除 sidecar', async () => {
    const sqlite = new Database(process.env.DATABASE_PATH!);
    const loserSidecar = seedLegacyDatabase(sqlite);
    sqlite.exec(`CREATE VIEW llm_usage AS SELECT 'blocked' AS id`);
    sqlite.close();

    const { getRawDb } = await import('../client');
    expect(() => getRawDb()).toThrow();

    const inspect = new Database(process.env.DATABASE_PATH!, { readonly: true });
    expect(inspect.prepare(`SELECT id FROM sources ORDER BY id`).all()).toEqual([
      { id: 'source-a' },
      { id: 'source-z' },
    ]);
    expect(inspect.prepare(`SELECT source_id FROM page_sources`).get()).toEqual({ source_id: 'source-z' });
    expect(inspect.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_dedup_cleanup'`).get())
      .toBeUndefined();
    expect(existsSync(loserSidecar)).toBe(true);
    inspect.close();
  });
});

async function reconcileDedupSidecars(
  sqlite: Database.Database,
): Promise<void> {
  const { ensureVaultRepo, getVaultGit } = await import('../../git/git-service');
  const { reconcileSourceDedupSidecars } = await import(
    '../../sources/source-dedup-cleanup'
  );
  await ensureVaultRepo();
  await reconcileSourceDedupSidecars(sqlite, process.env.VAULT_PATH!);
  expect((await getVaultGit().status()).isClean()).toBe(true);
  expect((await getVaultGit().log({ maxCount: 1 })).latest?.message)
    .toBe('维护：合并重复来源元数据');
}
