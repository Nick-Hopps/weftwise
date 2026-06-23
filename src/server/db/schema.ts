import {
  sqliteTable,
  text,
  integer,
  blob,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
