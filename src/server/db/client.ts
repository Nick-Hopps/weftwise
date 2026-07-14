import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import * as schema from './schema';
import { recoverInterruptedVaultMaintenance } from '../wiki/maintenance-files';

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

function primaryKeyColumns(table: string): string[] {
  const sqlite = rawSqlite!;
  const rows = sqlite
    .prepare(`SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`)
    .all(table) as Array<{ name: string; pk: number }>;
  return rows.map((r) => r.name);
}

function tableExists(table: string): boolean {
  const sqlite = rawSqlite!;
  const row = sqlite
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(table);
  return Boolean(row);
}

interface LegacyTableMigration {
  /** 目标表名（_new 临时表名由此派生） */
  table: string;
  /** CREATE TABLE 括号内的列与约束定义（新旧建表共用，保证 schema 一致） */
  columnsSql: string;
  /** 判断现存表是否需要重建迁移；入参为现存表的列名列表 */
  needsMigration: (cols: string[]) => boolean;
  /** 生成数据搬运 SQL（INSERT INTO <table>_new ... SELECT ... FROM <table>）与绑定参数 */
  copy: (cols: string[]) => { sql: string; params: unknown[] };
  /** 三个分支（新建 / 已迁移 / 重建完成）后都要执行的 SQL（如建唯一索引）；可选 */
  postSql?: string;
}

/**
 * 通用 legacy 表重建迁移：检查列 → 建 `_new` 表 → INSERT FROM → DROP → RENAME。
 *
 * 注意：与原实现一致，这里**不**包事务——调用方 `ensureTables` 以
 * `pragma foreign_keys = OFF/ON` 包裹整个迁移序列，语义保持不变。
 */
function legacyMigrateTable(migration: LegacyTableMigration): void {
  const sqlite = rawSqlite!;
  const { table, columnsSql, needsMigration, copy, postSql } = migration;

  // 表不存在：直接按新 schema 建表
  if (!tableExists(table)) {
    sqlite.exec(`CREATE TABLE ${table} (${columnsSql});`);
    if (postSql) sqlite.exec(postSql);
    return;
  }

  // 已是新 schema：仅补充 postSql（幂等）
  const cols = tableColumns(table);
  if (!needsMigration(cols)) {
    if (postSql) sqlite.exec(postSql);
    return;
  }

  // 重建迁移：_new 表 → 搬数据 → 替换原表
  sqlite.exec(`
    DROP TABLE IF EXISTS ${table}_new;
    CREATE TABLE ${table}_new (${columnsSql});
  `);
  const { sql, params } = copy(cols);
  sqlite.prepare(sql).run(...params);
  sqlite.exec(`
    DROP TABLE ${table};
    ALTER TABLE ${table}_new RENAME TO ${table};
  `);
  if (postSql) sqlite.exec(postSql);
}

function ensureSubjectsAndGeneral(): string {
  const sqlite = rawSqlite!;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      augmentation_level TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 存量库补列（同 migrateJobs 的 ALTER ADD COLUMN 增量补齐策略）
  if (!tableColumns('subjects').includes('augmentation_level')) {
    try {
      sqlite.exec(`ALTER TABLE subjects ADD COLUMN augmentation_level TEXT NOT NULL DEFAULT 'standard'`);
    } catch {
      // 已存在或不支持
    }
  }
  if (!tableColumns('subjects').includes('maintenance_state')) {
    sqlite.exec(`ALTER TABLE subjects ADD COLUMN maintenance_state TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!tableColumns('subjects').includes('mutation_epoch')) {
    sqlite.exec(`ALTER TABLE subjects ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0`);
  }

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
  legacyMigrateTable({
    table: 'pages',
    columnsSql: `
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
    `,
    // pages 特例：除 subject_id 列外，还要求复合主键 (subject_id, slug)
    needsMigration: (cols) => {
      if (!cols.includes('subject_id')) return true;
      const pkCols = primaryKeyColumns('pages');
      return !(pkCols.length === 2 && pkCols[0] === 'subject_id' && pkCols[1] === 'slug');
    },
    // 旧表可能已有 subject_id（仅主键不对）：COALESCE 保留已有值
    copy: (cols) => ({
      sql: cols.includes('subject_id')
        ? `INSERT INTO pages_new (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at)
           SELECT COALESCE(subject_id, ?), slug, title, path, summary, content_hash, tags, created_at, updated_at FROM pages`
        : `INSERT INTO pages_new (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at)
           SELECT ?, slug, title, path, summary, content_hash, tags, created_at, updated_at FROM pages`,
      params: [generalId],
    }),
    postSql: `CREATE UNIQUE INDEX IF NOT EXISTS pages_path_unique ON pages(path);`,
  });
}

function migratePageAliases(generalId: string): void {
  legacyMigrateTable({
    table: 'page_aliases',
    columnsSql: `
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      old_slug TEXT NOT NULL,
      new_slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, old_slug, new_slug)
    `,
    needsMigration: (cols) => !cols.includes('subject_id'),
    copy: () => ({
      sql: `INSERT INTO page_aliases_new (subject_id, old_slug, new_slug, created_at)
            SELECT ?, old_slug, new_slug, created_at FROM page_aliases`,
      params: [generalId],
    }),
  });
}

function migrateWikiLinks(generalId: string): void {
  legacyMigrateTable({
    table: 'wiki_links',
    columnsSql: `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      source_slug TEXT NOT NULL,
      target_subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
      target_slug TEXT NOT NULL,
      context TEXT DEFAULT ''
    `,
    needsMigration: (cols) =>
      !(cols.includes('subject_id') && cols.includes('target_subject_id')),
    copy: () => ({
      sql: `INSERT INTO wiki_links_new (subject_id, source_slug, target_subject_id, target_slug, context)
            SELECT ?, source_slug, ?, target_slug, context FROM wiki_links`,
      params: [generalId, generalId],
    }),
  });
}

function migrateSources(generalId: string): void {
  legacyMigrateTable({
    table: 'sources',
    columnsSql: `
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
      filename TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parsed_at TEXT,
      metadata_json TEXT DEFAULT '{}'
    `,
    needsMigration: (cols) => !cols.includes('subject_id'),
    copy: () => ({
      sql: `INSERT INTO sources_new (id, subject_id, filename, content_hash, parsed_at, metadata_json)
            SELECT id, ?, filename, content_hash, parsed_at, metadata_json FROM sources`,
      params: [generalId],
    }),
  });
}

function migratePageSources(generalId: string): void {
  legacyMigrateTable({
    table: 'page_sources',
    columnsSql: `
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      page_slug TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY (subject_id, page_slug, source_id)
    `,
    needsMigration: (cols) => !cols.includes('subject_id'),
    copy: () => ({
      sql: `INSERT INTO page_sources_new (subject_id, page_slug, source_id)
            SELECT ?, page_slug, source_id FROM page_sources`,
      params: [generalId],
    }),
  });
}

// 特例：jobs 不走 legacyMigrateTable —— 旧表只缺可空列，用 ALTER ADD COLUMN 增量补齐即可，无需重建
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
        attempt_count INTEGER DEFAULT 0,
        cancel_requested INTEGER DEFAULT 0
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
    ['cancel_requested', 'INTEGER DEFAULT 0'],
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

// 特例：operations 同 jobs，仅 ALTER ADD COLUMN 补列，无需重建迁移
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

function migrateAppSettings(): void {
  const sqlite = rawSqlite!;
  if (tableExists('app_settings')) return;
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

// 新表：ingest 断点续传检查点（job 运行态，成功即删；同 job_events 不设硬 FK）
function migrateIngestCheckpoints(): void {
  const sqlite = rawSqlite!;
  if (tableExists('ingest_checkpoints')) return;
  sqlite.exec(`
    CREATE TABLE ingest_checkpoints (
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, kind, key)
    );
  `);
}

function migrateConversations(): void {
  const sqlite = rawSqlite!;
  if (tableExists('conversations')) return;
  sqlite.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function migrateMessages(): void {
  const sqlite = rawSqlite!;
  if (tableExists('messages')) return;
  sqlite.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function migratePendingActions(): void {
  const sqlite = rawSqlite!;
  const createTableSql = (table: string) => `
    CREATE TABLE ${table} (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      operation TEXT NOT NULL
        CHECK (operation IN ('create','update','patch','delete','reenrich','metadata-patch','link-ensure','history-revert','workflow-reenrich-start','workflow-research-start','workflow-cancel')),
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
    )`;

  if (!tableExists('pending_actions')) {
    sqlite.exec(`${createTableSql('pending_actions')};`);
    return;
  }

  const definition = sqlite.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_actions'`,
  ).get() as { sql: string | null } | undefined;
  const currentSql = definition?.sql?.toLowerCase() ?? '';
  if (
    currentSql.includes("'metadata-patch'")
    && currentSql.includes("'link-ensure'")
    && currentSql.includes("'history-revert'")
    && currentSql.includes("'workflow-reenrich-start'")
    && currentSql.includes("'workflow-research-start'")
    && currentSql.includes("'workflow-cancel'")
  ) {
    return;
  }

  // CHECK 不能 ALTER；完整重建必须原子化，copy 任一行失败时保留旧表与全部历史。
  sqlite.transaction(() => {
    sqlite.exec(`
      DROP TABLE IF EXISTS pending_actions_new;
      ${createTableSql('pending_actions_new')};
      INSERT INTO pending_actions_new (
        id, conversation_id, subject_id, operation, payload_json, payload_hash,
        preview_json, status, created_at, updated_at, expires_at, approved_at,
        applied_at, operation_id, job_id, error_json
      )
      SELECT
        id, conversation_id, subject_id, operation, payload_json, payload_hash,
        preview_json, status, created_at, updated_at, expires_at, approved_at,
        applied_at, operation_id, job_id, error_json
      FROM pending_actions;
      DROP TABLE pending_actions;
      ALTER TABLE pending_actions_new RENAME TO pending_actions;
    `);
  })();
}

function migratePageEmbeddings(): void {
  const sqlite = rawSqlite!;
  if (tableExists('page_embeddings')) return;
  sqlite.exec(`
    CREATE TABLE page_embeddings (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      model TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, slug)
    );
  `);
}

function migratePageMaturity(): void {
  const sqlite = rawSqlite!;
  if (tableExists('page_maturity')) return;
  sqlite.exec(`
    CREATE TABLE page_maturity (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      passes INTEGER NOT NULL DEFAULT 0,
      last_enriched_at TEXT,
      interval_days INTEGER NOT NULL DEFAULT 1,
      next_due_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, slug)
    );
  `);
}

// ── Cognitive Lens（读时内容重塑）三表 ───────────────────────────
function migrateUserProfiles(): void {
  const sqlite = rawSqlite!;
  if (tableExists('user_profiles')) return;
  sqlite.exec(`
    CREATE TABLE user_profiles (
      user_id TEXT PRIMARY KEY,
      background_summary TEXT NOT NULL DEFAULT '',
      style_prefs TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      onboarded_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

// 故意不挂 subjects FK：可丢弃重建的读侧缓存，由 deleteBySubject + 命中校验自洽。
function migratePageRenditions(): void {
  const sqlite = rawSqlite!;
  if (tableExists('page_renditions')) return;
  sqlite.exec(`
    CREATE TABLE page_renditions (
      subject_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      profile_version INTEGER NOT NULL,
      rendered_md TEXT NOT NULL,
      model TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, slug)
    );
  `);
}

function migrateProfileSignals(): void {
  const sqlite = rawSqlite!;
  if (tableExists('profile_signals')) return;
  sqlite.exec(`
    CREATE TABLE profile_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      subject_id TEXT,
      slug TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

// T3.2：待研究问题队列（Ask AI 未命中信号 + 手动添加）。
function migrateResearchBacklog(): void {
  const sqlite = rawSqlite!;
  if (tableExists('research_backlog')) return;
  sqlite.exec(`
    CREATE TABLE research_backlog (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      research_job_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

/** Phase 2C：Research 候选批准、导入与验证 provenance。 */
function migrateResearchProvenance(): void {
  const sqlite = rawSqlite!;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY NOT NULL,
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      research_job_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('findings','topic')),
      lint_job_id TEXT,
      topic TEXT,
      topics_json TEXT NOT NULL DEFAULT '[]',
      queries_json TEXT NOT NULL DEFAULT '[]',
      candidate_set_hash TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('awaiting-approval','importing','verifying','completed','partial','failed','dismissed','empty')),
      version INTEGER NOT NULL DEFAULT 1,
      verification_lint_job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      error_json TEXT
    );

    CREATE TABLE IF NOT EXISTS research_run_findings (
      run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
      finding_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (verification_status IN ('pending','fixed','residual','unverifiable')),
      verified_at TEXT,
      verification_snapshot_json TEXT,
      PRIMARY KEY (run_id, finding_id)
    );

    CREATE TABLE IF NOT EXISTS research_approvals (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
      selected_candidate_ids_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      coordinator_job_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_candidates (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
      normalized_url TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      rank INTEGER NOT NULL,
      decision TEXT NOT NULL DEFAULT 'pending'
        CHECK (decision IN ('pending','approved','rejected')),
      approval_id TEXT,
      decided_at TEXT,
      CONSTRAINT research_candidates_approval_run_fk
        FOREIGN KEY (approval_id, run_id)
        REFERENCES research_approvals(id, run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS research_candidate_ingests (
      approval_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','fetching','queued','running','completed','failed')),
      source_id TEXT,
      ingest_job_id TEXT,
      operation_ids_json TEXT NOT NULL DEFAULT '[]',
      touched_pages_json TEXT NOT NULL DEFAULT '[]',
      commit_sha TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      error_json TEXT,
      PRIMARY KEY (approval_id, candidate_id),
      CONSTRAINT research_candidate_ingests_approval_run_fk
        FOREIGN KEY (approval_id, run_id)
        REFERENCES research_approvals(id, run_id) ON DELETE CASCADE,
      CONSTRAINT research_candidate_ingests_candidate_run_fk
        FOREIGN KEY (candidate_id, run_id)
        REFERENCES research_candidates(id, run_id) ON DELETE CASCADE
    );
  `);
}

/**
 * 创建 source identity 唯一索引前收敛历史重复行。DB 引用迁移原子化；
 * loser sidecar 的文件清理由 source-store 维护步骤补偿。
 */
function dedupeSourcesForUniqueIdentity(): void {
  const sqlite = rawSqlite!;
  const duplicates = sqlite.prepare(`
    SELECT loser.id AS loser_id, winner.id AS winner_id, subject.slug AS subject_slug
    FROM sources loser
    JOIN sources winner
      ON winner.subject_id = loser.subject_id
     AND winner.content_hash = loser.content_hash
     AND winner.filename = loser.filename
     AND winner.id = (
       SELECT MIN(candidate.id)
       FROM sources candidate
       WHERE candidate.subject_id = loser.subject_id
         AND candidate.content_hash = loser.content_hash
         AND candidate.filename = loser.filename
     )
    JOIN subjects subject ON subject.id = loser.subject_id
    WHERE loser.id != winner.id
    ORDER BY loser.id
  `).all() as Array<{
    loser_id: string;
    winner_id: string;
    subject_slug: string;
  }>;
  if (duplicates.length === 0) return;

  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS source_dedup_cleanup (
        loser_id TEXT PRIMARY KEY NOT NULL,
        winner_id TEXT NOT NULL,
        subject_slug TEXT NOT NULL,
        filename TEXT NOT NULL
      )
    `);
    for (const duplicate of duplicates) {
      const {
        loser_id: loserId,
        winner_id: winnerId,
        subject_slug: subjectSlug,
      } = duplicate;
      const filename = sqlite.prepare(`SELECT filename FROM sources WHERE id = ?`)
        .pluck()
        .get(loserId) as string;
      sqlite.prepare(`
        INSERT OR IGNORE INTO source_dedup_cleanup (
          loser_id, winner_id, subject_slug, filename
        ) VALUES (?, ?, ?, ?)
      `).run(loserId, winnerId, subjectSlug, filename);
      sqlite.prepare(`
        INSERT OR IGNORE INTO page_sources (subject_id, page_slug, source_id)
        SELECT subject_id, page_slug, ? FROM page_sources WHERE source_id = ?
      `).run(winnerId, loserId);
      sqlite.prepare(`DELETE FROM page_sources WHERE source_id = ?`).run(loserId);
      sqlite.prepare(`
        UPDATE jobs
        SET params_json = json_set(params_json, '$.sourceId', ?)
        WHERE json_valid(params_json)
          AND json_extract(params_json, '$.sourceId') = ?
      `).run(winnerId, loserId);
      if (tableExists('research_candidate_ingests')) {
        sqlite.prepare(`
          UPDATE research_candidate_ingests SET source_id = ? WHERE source_id = ?
        `).run(winnerId, loserId);
      }
      sqlite.prepare(`DELETE FROM sources WHERE id = ?`).run(loserId);
    }
  })();
}

// LLM 用量明细表（设置页 Usage 统计）。
function migrateLlmUsage(): void {
  const sqlite = rawSqlite!;
  if (tableExists('llm_usage')) return;
  sqlite.exec(`
    CREATE TABLE llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_llm_usage_created_at ON llm_usage(created_at);
  `);
}

// 特例：FTS5 虚拟表不支持 _new + INSERT FROM 重建（索引可由 pages 重建），缺列时直接 DROP 重建
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

// 热路径二级索引（除各表已声明的 PK / UNIQUE 外）。
// 必须建在所有表迁移（含 legacyMigrateTable 的 DROP+RENAME 重建）之后，
// 否则会随表重建被丢弃。CREATE INDEX IF NOT EXISTS 幂等。
// 注：page_sources(subject_id, page_slug) 不建——复合 PK (subject_id, page_slug, source_id) 前缀已覆盖。
function ensureIndexes(): void {
  const sqlite = rawSqlite!;
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS wiki_links_target_idx
      ON wiki_links(target_subject_id, target_slug);
    CREATE INDEX IF NOT EXISTS wiki_links_source_idx
      ON wiki_links(subject_id, source_slug);
    CREATE INDEX IF NOT EXISTS job_events_job_idx
      ON job_events(job_id, created_at, id);
    CREATE INDEX IF NOT EXISTS jobs_status_type_created_idx
      ON jobs(status, type, created_at);
    CREATE INDEX IF NOT EXISTS jobs_created_id_idx
      ON jobs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS jobs_subject_created_id_idx
      ON jobs(subject_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS jobs_subject_type_status_created_id_idx
      ON jobs(subject_id, type, status, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS jobs_subject_type_status_completed_id_idx
      ON jobs(subject_id, type, status, completed_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS jobs_subject_ingest_source_created_id_idx
      ON jobs(
        subject_id,
        CASE WHEN json_valid(params_json)
          THEN json_extract(params_json, '$.sourceId') END,
        created_at DESC,
        id DESC
      )
      WHERE type = 'ingest';
    CREATE INDEX IF NOT EXISTS jobs_subject_ingest_source_status_created_id_idx
      ON jobs(
        subject_id,
        CASE WHEN json_valid(params_json)
          THEN json_extract(params_json, '$.sourceId') END,
        status,
        created_at DESC,
        id DESC
      )
      WHERE type = 'ingest';
    CREATE INDEX IF NOT EXISTS research_backlog_subject_status_idx
      ON research_backlog(subject_id, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS sources_subject_hash_filename_unique
      ON sources(subject_id, content_hash, filename);
    CREATE UNIQUE INDEX IF NOT EXISTS research_runs_research_job_id_unique
      ON research_runs(research_job_id);
    CREATE INDEX IF NOT EXISTS research_runs_subject_status_updated_idx
      ON research_runs(subject_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS research_approvals_run_unique
      ON research_approvals(run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS research_approvals_id_run_unique
      ON research_approvals(id, run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS research_approvals_run_idempotency_unique
      ON research_approvals(run_id, idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS research_candidates_run_url_unique
      ON research_candidates(run_id, normalized_url);
    CREATE UNIQUE INDEX IF NOT EXISTS research_candidates_id_run_unique
      ON research_candidates(id, run_id);
    CREATE INDEX IF NOT EXISTS research_candidates_run_rank_idx
      ON research_candidates(run_id, rank);
    CREATE UNIQUE INDEX IF NOT EXISTS research_candidate_ingests_ingest_job_unique
      ON research_candidate_ingests(ingest_job_id);
    CREATE INDEX IF NOT EXISTS research_candidate_ingests_status_lease_idx
      ON research_candidate_ingests(status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS pending_actions_conversation_status_idx
      ON pending_actions(conversation_id, status, created_at);
    CREATE INDEX IF NOT EXISTS pending_actions_subject_status_expiry_idx
      ON pending_actions(subject_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS pending_actions_status_expiry_idx
      ON pending_actions(status, expires_at);
  `);
}

function ensureTables() {
  if (!rawSqlite) return;

  rawSqlite.pragma('foreign_keys = OFF');
  try {
    const migrate = rawSqlite.transaction(() => {
      const generalId = ensureSubjectsAndGeneral();
      migratePages(generalId);
      migratePageAliases(generalId);
      migrateWikiLinks(generalId);
      migrateSources(generalId);
      migratePageSources(generalId);
      migrateJobs();
      migrateJobEvents();
      migrateOperations();
      migrateAppSettings();
      migrateIngestCheckpoints();
      migrateConversations();
      migrateMessages();
      migratePendingActions();
      migratePageEmbeddings();
      migratePageMaturity();
      migrateUserProfiles();
      migratePageRenditions();
      migrateProfileSignals();
      migrateResearchBacklog();
      migrateResearchProvenance();
      dedupeSourcesForUniqueIdentity();
      migrateLlmUsage();
      ensurePagesFts();
      ensureIndexes();
    });
    migrate.immediate();
  } finally {
    rawSqlite.pragma('foreign_keys = ON');
  }

  // 先恢复中断维护，reset/delete 未补偿完成时 Subject 保持 fail-closed。
  recoverInterruptedVaultMaintenance(rawSqlite);
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
