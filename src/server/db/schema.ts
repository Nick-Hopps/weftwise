import {
  sqliteTable,
  text,
  integer,
  blob,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const subjects = sqliteTable('subjects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  augmentationLevel: text('augmentation_level').notNull().default('standard'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type AppSettingsRow = typeof appSettings.$inferSelect;

export const pages = sqliteTable(
  'pages',
  {
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    path: text('path').notNull(),
    summary: text('summary').default(''),
    contentHash: text('content_hash').notNull(),
    tags: text('tags').default('[]'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.subjectId, t.slug] }),
    pathUnique: uniqueIndex('pages_path_unique').on(t.path),
  })
);

export const pageAliases = sqliteTable(
  'page_aliases',
  {
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    oldSlug: text('old_slug').notNull(),
    newSlug: text('new_slug').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.subjectId, t.oldSlug, t.newSlug] }),
  })
);

export const wikiLinks = sqliteTable('wiki_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  subjectId: text('subject_id')
    .notNull()
    .references(() => subjects.id, { onDelete: 'cascade' }),
  sourceSlug: text('source_slug').notNull(),
  targetSubjectId: text('target_subject_id')
    .notNull()
    .references(() => subjects.id, { onDelete: 'restrict' }),
  targetSlug: text('target_slug').notNull(),
  context: text('context').default(''),
});

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  subjectId: text('subject_id')
    .notNull()
    .references(() => subjects.id, { onDelete: 'restrict' }),
  filename: text('filename').notNull(),
  contentHash: text('content_hash').notNull(),
  parsedAt: text('parsed_at'),
  metadataJson: text('metadata_json').default('{}'),
});

export const pageSources = sqliteTable(
  'page_sources',
  {
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    pageSlug: text('page_slug').notNull(),
    sourceId: text('source_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.subjectId, t.pageSlug, t.sourceId] }),
  })
);

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  subjectId: text('subject_id').references(() => subjects.id, {
    onDelete: 'set null',
  }),
  paramsJson: text('params_json').default('{}'),
  resultJson: text('result_json'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  leaseExpiresAt: text('lease_expires_at'),
  heartbeatAt: text('heartbeat_at'),
  attemptCount: integer('attempt_count').default(0),
});

export const jobEvents = sqliteTable('job_events', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  type: text('type').notNull(),
  message: text('message').notNull(),
  dataJson: text('data_json'),
  createdAt: text('created_at').notNull(),
});

export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  subjectId: text('subject_id').references(() => subjects.id, {
    onDelete: 'set null',
  }),
  preHead: text('pre_head').notNull(),
  postHead: text('post_head'),
  changesetJson: text('changeset_json').notNull(),
  status: text('status').notNull().default('pending'),
});

export const ingestCheckpoints = sqliteTable(
  'ingest_checkpoints',
  {
    jobId: text('job_id').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    dataJson: text('data_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.jobId, t.kind, t.key] }),
  })
);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  subjectId: text('subject_id')
    .notNull()
    .references(() => subjects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  citationsJson: text('citations_json'),
  createdAt: text('created_at').notNull(),
});

export const pendingActions = sqliteTable(
  'pending_actions',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    payloadJson: text('payload_json').notNull(),
    payloadHash: text('payload_hash').notNull(),
    previewJson: text('preview_json').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    approvedAt: text('approved_at'),
    appliedAt: text('applied_at'),
    operationId: text('operation_id'),
    jobId: text('job_id'),
    errorJson: text('error_json'),
  },
  (t) => ({
    conversationStatusIdx: index('pending_actions_conversation_status_idx')
      .on(t.conversationId, t.status, t.createdAt),
    subjectStatusExpiryIdx: index('pending_actions_subject_status_expiry_idx')
      .on(t.subjectId, t.status, t.expiresAt),
    statusExpiryIdx: index('pending_actions_status_expiry_idx')
      .on(t.status, t.expiresAt),
    operationCheck: check(
      'pending_actions_operation_check',
      sql`${t.operation} IN ('create','update','patch','delete','reenrich')`,
    ),
    statusCheck: check(
      'pending_actions_status_check',
      sql`${t.status} IN ('pending','approved','executing','applied','rejected','expired','failed')`,
    ),
  }),
);

export const pageEmbeddings = sqliteTable(
  'page_embeddings',
  {
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    dim: integer('dim').notNull(),
    vector: blob('vector').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.subjectId, t.slug] }) })
);

export const pageMaturity = sqliteTable(
  'page_maturity',
  {
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    passes: integer('passes').notNull().default(0),
    lastEnrichedAt: text('last_enriched_at'),
    intervalDays: integer('interval_days').notNull().default(1),
    nextDueAt: text('next_due_at').notNull(),
    state: text('state').notNull().default('active'),
    priority: integer('priority').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.subjectId, t.slug] }) })
);

// ── Cognitive Lens（读时内容重塑）─────────────────────────────────
// 画像挂账户层（今天单例 userId='local'，未来多租户已 user-keyed）。
export const userProfiles = sqliteTable('user_profiles', {
  userId: text('user_id').primaryKey(),
  backgroundSummary: text('background_summary').notNull().default(''),
  stylePrefs: text('style_prefs').notNull(), // JSON: StylePrefs
  version: integer('version').notNull().default(1),
  onboardedAt: text('onboarded_at'),
  updatedAt: text('updated_at').notNull(),
});

// 重塑缓存：一页一行，按 (canonical_hash, profile_version) 惰性失效。
// 故意不挂 subjects FK —— 这是可随时丢弃重建的读侧派生缓存，
// 由 renditions-repo.deleteBySubject + 命中校验自洽。
export const pageRenditions = sqliteTable(
  'page_renditions',
  {
    subjectId: text('subject_id').notNull(),
    slug: text('slug').notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    profileVersion: integer('profile_version').notNull(),
    renderedMd: text('rendered_md').notNull(),
    model: text('model'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.subjectId, t.slug] }) })
);

// 反馈信号（append-only，喂确定性 reducer）。
export const profileSignals = sqliteTable('profile_signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  subjectId: text('subject_id'),
  slug: text('slug'),
  createdAt: text('created_at').notNull(),
});

// T3.2：待研究问题队列（Ask AI 未命中信号 + 手动添加），subject-scoped。
export const researchBacklog = sqliteTable('research_backlog', {
  id: text('id').primaryKey(),
  subjectId: text('subject_id')
    .notNull()
    .references(() => subjects.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  source: text('source').notNull(), // 'ask-ai' | 'manual'
  status: text('status').notNull().default('open'), // 'open' | 'researched' | 'dismissed'
  researchJobId: text('research_job_id'),
  createdAt: text('created_at').notNull(),
});

// LLM 用量明细：一次 LLM 调用一行（app 级资源，非 subject-scoped，无 FK）。
export const llmUsage = sqliteTable('llm_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task: text('task').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  createdAt: integer('created_at').notNull(), // epoch ms
});
