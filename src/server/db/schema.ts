import {
  sqliteTable,
  text,
  integer,
  blob,
  primaryKey,
  foreignKey,
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
  maintenanceState: text('maintenance_state').notNull().default('active'),
  mutationEpoch: integer('mutation_epoch').notNull().default(0),
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
    oldSlugUnique: uniqueIndex('page_aliases_subject_old_unique')
      .on(t.subjectId, t.oldSlug),
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

export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'restrict' }),
    filename: text('filename').notNull(),
    contentHash: text('content_hash').notNull(),
    parsedAt: text('parsed_at'),
    metadataJson: text('metadata_json').default('{}'),
  },
  (t) => ({
    identityUnique: uniqueIndex('sources_subject_hash_filename_unique')
      .on(t.subjectId, t.contentHash, t.filename),
  }),
);

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
      sql`${t.operation} IN ('create','update','patch','delete','reenrich','metadata-patch','link-ensure','history-revert','workflow-reenrich-start','workflow-research-start','workflow-cancel','move','tag-batch')`,
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

// 重塑版本：每页保存最新一次成功产物；不挂 subjects FK，由 repo 显式级联清理。
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

// 重塑专属图片不进入 vault；与正文在同一 SQLite 事务内替换。
export const pageRenditionAssets = sqliteTable(
  'page_rendition_assets',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id').notNull(),
    slug: text('slug').notNull(),
    mediaType: text('media_type').notNull(),
    dataBase64: text('data_base64').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ pageIdx: index('page_rendition_assets_page_idx').on(t.subjectId, t.slug) }),
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

// Research 批准溯源：run 是批次状态唯一真实源，approval 是不可变批准事实。
export const researchRuns = sqliteTable(
  'research_runs',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    researchJobId: text('research_job_id').notNull().unique(),
    origin: text('origin').notNull(),
    lintJobId: text('lint_job_id'),
    topic: text('topic'),
    topicsJson: text('topics_json').notNull().default('[]'),
    queriesJson: text('queries_json').notNull().default('[]'),
    candidateSetHash: text('candidate_set_hash').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull().default(1),
    verificationLintJobId: text('verification_lint_job_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
    errorJson: text('error_json'),
  },
  (t) => ({
    subjectStatusUpdatedIdx: index('research_runs_subject_status_updated_idx')
      .on(t.subjectId, t.status, t.updatedAt),
    originCheck: check(
      'research_runs_origin_check',
      sql`${t.origin} IN ('findings','topic')`,
    ),
    statusCheck: check(
      'research_runs_status_check',
      sql`${t.status} IN ('awaiting-approval','importing','verifying','completed','partial','failed','dismissed','empty')`,
    ),
  }),
);

export const researchRunFindings = sqliteTable(
  'research_run_findings',
  {
    runId: text('run_id')
      .notNull()
      .references(() => researchRuns.id, { onDelete: 'cascade' }),
    findingId: text('finding_id').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    verificationStatus: text('verification_status').notNull().default('pending'),
    verifiedAt: text('verified_at'),
    verificationSnapshotJson: text('verification_snapshot_json'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.findingId] }),
    verificationStatusCheck: check(
      'research_run_findings_verification_status_check',
      sql`${t.verificationStatus} IN ('pending','fixed','residual','unverifiable')`,
    ),
  }),
);

export const researchApprovals = sqliteTable(
  'research_approvals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => researchRuns.id, { onDelete: 'cascade' }),
    selectedCandidateIdsJson: text('selected_candidate_ids_json').notNull(),
    payloadHash: text('payload_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    coordinatorJobId: text('coordinator_job_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    runUnique: uniqueIndex('research_approvals_run_unique').on(t.runId),
    idRunUnique: uniqueIndex('research_approvals_id_run_unique').on(t.id, t.runId),
    runIdempotencyUnique: uniqueIndex('research_approvals_run_idempotency_unique')
      .on(t.runId, t.idempotencyKey),
  }),
);

export const researchCandidates = sqliteTable(
  'research_candidates',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => researchRuns.id, { onDelete: 'cascade' }),
    normalizedUrl: text('normalized_url').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    rank: integer('rank').notNull(),
    decision: text('decision').notNull().default('pending'),
    approvalId: text('approval_id'),
    decidedAt: text('decided_at'),
  },
  (t) => ({
    runUrlUnique: uniqueIndex('research_candidates_run_url_unique')
      .on(t.runId, t.normalizedUrl),
    idRunUnique: uniqueIndex('research_candidates_id_run_unique').on(t.id, t.runId),
    runRankIdx: index('research_candidates_run_rank_idx').on(t.runId, t.rank),
    decisionCheck: check(
      'research_candidates_decision_check',
      sql`${t.decision} IN ('pending','approved','rejected')`,
    ),
    approvalRunFk: foreignKey({
      columns: [t.approvalId, t.runId],
      foreignColumns: [researchApprovals.id, researchApprovals.runId],
      name: 'research_candidates_approval_run_fk',
    }).onDelete('cascade'),
  }),
);

export const researchCandidateIngests = sqliteTable(
  'research_candidate_ingests',
  {
    approvalId: text('approval_id').notNull(),
    candidateId: text('candidate_id').notNull(),
    runId: text('run_id').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    status: text('status').notNull().default('pending'),
    sourceId: text('source_id'),
    ingestJobId: text('ingest_job_id'),
    operationIdsJson: text('operation_ids_json').notNull().default('[]'),
    touchedPagesJson: text('touched_pages_json').notNull().default('[]'),
    commitSha: text('commit_sha'),
    claimToken: text('claim_token'),
    leaseExpiresAt: text('lease_expires_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
    errorJson: text('error_json'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.approvalId, t.candidateId] }),
    ingestJobUnique: uniqueIndex('research_candidate_ingests_ingest_job_unique')
      .on(t.ingestJobId),
    statusLeaseIdx: index('research_candidate_ingests_status_lease_idx')
      .on(t.status, t.leaseExpiresAt),
    statusCheck: check(
      'research_candidate_ingests_status_check',
      sql`${t.status} IN ('pending','fetching','queued','running','completed','failed')`,
    ),
    approvalRunFk: foreignKey({
      columns: [t.approvalId, t.runId],
      foreignColumns: [researchApprovals.id, researchApprovals.runId],
      name: 'research_candidate_ingests_approval_run_fk',
    }).onDelete('cascade'),
    candidateRunFk: foreignKey({
      columns: [t.candidateId, t.runId],
      foreignColumns: [researchCandidates.id, researchCandidates.runId],
      name: 'research_candidate_ingests_candidate_run_fk',
    }).onDelete('cascade'),
  }),
);

// LLM 用量明细：一次 LLM 调用一行（app 级资源，非 subject-scoped，无 FK）。
export const llmUsage = sqliteTable('llm_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task: text('task').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  createdAt: integer('created_at').notNull(), // epoch ms
});
