import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

export const pages = sqliteTable('pages', {
  slug: text('slug').primaryKey(),
  title: text('title').notNull(),
  path: text('path').notNull(),
  summary: text('summary').default(''),
  contentHash: text('content_hash').notNull(),
  tags: text('tags').default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const pageAliases = sqliteTable(
  'page_aliases',
  {
    oldSlug: text('old_slug').notNull(),
    newSlug: text('new_slug').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.oldSlug, t.newSlug] }),
  })
);

export const wikiLinks = sqliteTable('wiki_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceSlug: text('source_slug').notNull(),
  targetSlug: text('target_slug').notNull(),
  context: text('context').default(''),
});

export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  filename: text('filename').notNull(),
  contentHash: text('content_hash').notNull(),
  parsedAt: text('parsed_at'),
  metadataJson: text('metadata_json').default('{}'),
});

export const pageSources = sqliteTable(
  'page_sources',
  {
    pageSlug: text('page_slug').notNull(),
    sourceId: text('source_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pageSlug, t.sourceId] }),
  })
);

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
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
  preHead: text('pre_head').notNull(),
  postHead: text('post_head'),
  changesetJson: text('changeset_json').notNull(),
  status: text('status').notNull().default('pending'),
});
