import { z } from 'zod';

export type SubjectId = string;

/** 每个 subject 独立的增益强度（ingest/re-enrich 读取）。`off` = 退回纯忠实层。 */
export type AugmentationLevel = 'off' | 'light' | 'standard' | 'deep';
export const DEFAULT_AUGMENTATION_LEVEL: AugmentationLevel = 'standard';

export interface Subject {
  id: SubjectId;
  slug: string;
  name: string;
  description: string;
  augmentationLevel: AugmentationLevel;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/subjects` 列表项：Subject 摘要 + 页面计数 */
export interface SubjectListEntry {
  id: SubjectId;
  slug: string;
  name: string;
  description: string;
  augmentationLevel: AugmentationLevel;
  pageCount: number;
}

/** `subject.list` 模型工具返回项；pageCount 只统计非 meta 页面。 */
export interface SubjectToolListEntry {
  id: SubjectId;
  slug: string;
  name: string;
  description: string;
  pageCount: number;
}

export interface SubjectToolListResult {
  subjects: SubjectToolListEntry[];
}

export interface CrossSubjectSearchInput {
  query: string;
  subjectSlugs: string[];
  limit?: number;
}

export interface CrossSubjectSearchResult {
  hits: Array<{
    subjectSlug: string;
    slug: string;
    title: string;
    summary: string;
  }>;
}

export interface CrossSubjectReadInput {
  subjectSlug: string;
  slug: string;
}

export interface CrossSubjectReadResult {
  found: boolean;
  subjectSlug: string;
  slug: string;
  title: string | null;
  body: string | null;
}

/** Wiki 页面 YAML frontmatter（解析/序列化单一真实源在 server/wiki/frontmatter.ts） */
export interface WikiFrontmatter {
  title: string;
  created: string;
  updated: string;
  tags: string[];
  sources: string[];
  summary?: string;
  aliases?: string[];
}

/** 从 markdown 中提取出的一条 wikilink（提取逻辑单一真实源在 server/wiki/wikilinks.ts） */
export interface ExtractedLink {
  /** The full raw token including brackets, e.g. `[[Page Name|Alias]]` */
  raw: string;
  /** The page-name portion of the inner content, after stripping subject/alias/section. */
  rawTitle: string;
  /** The resolved target slug (page name only, normalized) */
  target: string;
  /**
   * Subject slug the link resolves into. Equals the explicit `subject:` prefix
   * when present; otherwise falls back to the caller-provided
   * `currentSubjectSlug`. May be the empty string when no current subject is
   * supplied — callers should treat that as "use today's subject context".
   */
  targetSubjectSlug: string;
  /** Display alias if present (`[[Target|Alias]]`), otherwise null */
  alias: string | null;
  /** Byte offsets of the `[[…]]` token in the original markdown string */
  position: { start: number; end: number };
}

/**
 * 把页面标题解析为 canonical slug。
 *
 * `targetSubjectSlug` 是 wikilink 在拆除显式 `subject:` 前缀后确定的目标
 * Subject；resolver 必须据此隔离同名页面。参数保持可选，以兼容只处理单一
 * Subject 的旧调用方。
 */
export type TitleResolver = (
  title: string,
  targetSubjectSlug?: string,
) => string | undefined;

/** frontmatter + body + links 的组合解析结果 */
export interface WikiDocument {
  frontmatter: WikiFrontmatter;
  body: string;
  links: ExtractedLink[];
}

export interface WikiPage {
  slug: string;
  title: string;
  path: string;
  summary: string;
  contentHash: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  subjectId: SubjectId;
}

export interface WikiLink {
  sourceSlug: string;
  targetSlug: string;
  context: string;
  subjectId: SubjectId;
  targetSubjectId: SubjectId;
}

export type MetadataPatchField = 'title' | 'summary' | 'tags' | 'aliases';

export interface MetadataPatchInput {
  slug: string;
  title?: string;
  summary?: string;
  tags?: string[];
  aliases?: string[];
}

export interface MetadataPatchResult {
  updatedSlug: string;
  referencesUpdated: number;
  changedFields: MetadataPatchField[];
}

export type LinkEnsureMode = 'link' | 'unlink' | 'retarget';

export interface LinkEnsureInput {
  sourceSlug: string;
  targetSubjectSlug?: string;
  targetSlug: string;
  oldString: string;
  displayText?: string;
  mode: LinkEnsureMode;
}

export interface LinkEnsureResult {
  updatedSlug: string;
  mode: LinkEnsureMode;
  targetSubjectSlug: string;
  targetSlug: string;
}

export type InspectSection = 'links' | 'backlinks' | 'sources' | 'health';

export interface WikiInspection {
  found: boolean;
  page: null | {
    slug: string;
    title: string;
    summary: string;
    tags: string[];
    updatedAt: string;
  };
  outgoing: Array<{
    subjectSlug: string;
    slug: string;
    title: string | null;
    context: string;
    resolved: boolean;
  }>;
  backlinks: Array<{
    subjectSlug: string;
    slug: string;
    title: string;
  }>;
  sources: Array<{
    id: string;
    filename: string;
    originUrl: string | null;
    parsedAt: string | null;
    stale: boolean;
  }>;
  health: {
    brokenLinks: number;
    inboundCount: number;
    outboundCount: number;
    sourceCount: number;
  };
}

export interface SourceSearchInput {
  query: string;
  pageSlug?: string;
  sourceIds?: string[];
  limit?: number;
}

export interface SourceSearchResult {
  hits: Array<{
    sourceId: string;
    filename: string;
    chunkId: string;
    heading: string;
    excerpt: string;
    score: number;
  }>;
}

export interface SourceReadInput {
  sourceId: string;
  chunkId?: string;
  offset?: number;
  limit?: number;
}

export interface SourceReadResult {
  sourceId: string;
  filename: string;
  chunkId: string | null;
  content: string;
  nextOffset: number | null;
  truncated: boolean;
}

export interface PageListInput {
  cursor?: string;
  limit?: number;
  tag?: string;
  sort?: 'title' | 'updated';
}

export interface PageListResult {
  pages: Array<{
    slug: string;
    title: string;
    summary: string;
    tags: string[];
    updatedAt: string;
  }>;
  nextCursor: string | null;
}

export interface Job {
  id: string;
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'embed-index' | 'curate' | 're-enrich' | 'fix' | 'research' | 'research-import';
  status: 'pending' | 'running' | 'completed' | 'failed';
  paramsJson: string;
  resultJson: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  attemptCount: number;
  subjectId: SubjectId | null;
}

export interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  message: string;
  dataJson: string | null;
  createdAt: string;
}

export interface WorkflowStatusInput {
  jobId: string;
}

export interface WorkflowStatusResult {
  found: boolean;
  job: null | {
    jobId: string;
    type: Job['type'];
    status: Job['status'];
    cancelled: boolean;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    attemptCount: number;
  };
}

export interface WorkflowReenrichStartInput {
  slug: string;
}

export interface WorkflowResearchStartInput {
  topic: string;
}

export interface WorkflowCancelInput {
  jobId: string;
}

/** ingest 断点续传进度快照（API 响应 + 续传事件共用）。totalPages 仅在 plan 已缓存时可知。 */
export interface CheckpointProgress {
  plan: boolean;
  chunkSummaries: number;
  writerPages: number;
  totalPages: number | null;
}

export interface Source {
  id: string;
  filename: string;
  contentHash: string;
  parsedAt: string | null;
  metadataJson: string;
  subjectId: SubjectId;
}

export type PageSourceFormat = 'pdf' | 'markdown' | 'html' | 'text';

export type HtmlRisk = 'safe' | 'suspicious';

export interface HtmlSafety {
  risk: HtmlRisk;
  /** 命中的高危信号的中文人读说明；safe 时为空数组。 */
  signals: string[];
}

/**
 * A source document a page was written from, prepared for the split reading
 * view. Markdown/text ship their (capped) body in `text`; pdf/html ship no
 * payload and are rendered client-side via an iframe over `/api/sources/{id}/raw`.
 */
export interface PageSourceDoc {
  id: string;
  name: string;
  format: PageSourceFormat;
  added: string;
  meta?: string;
  /** 仅 markdown/text 有意义：正文按 120K 截断时为 true。pdf/html 直出完整文件，不截断。 */
  truncated?: boolean;
  /** markdown/text 的正文（已截断）。pdf/html 不下发 payload（由 iframe 渲染）。 */
  text?: string;
  /** 仅 html 有意义：服务端启发式扫描结论，驱动 iframe sandbox 决策与警告条。 */
  htmlSafety?: HtmlSafety;
}

export interface IngestResult {
  pagesCreated: string[];
  pagesUpdated: string[];
  linksAdded: number;
  commitSha: string;
}

export interface QueryResult {
  answer: string;
  citations: WikiCitation[];
  savedAsPage: string | null;
}

/** Ask AI 引用；旧消息没有 subjectSlug 时按会话所属 Subject 解释。 */
export interface WikiCitation {
  pageSlug: string;
  excerpt: string;
  subjectSlug?: string;
}

/** research job 输出的单条候选：只发现不写入，批准后由 research-import 协调导入。 */
export interface ResearchCandidate {
  url: string;
  title: string;
  snippet: string;
  /** triage 评分 0-3；triage 降级时为 null（按搜索排名前 3 未评分）。 */
  score: number | null;
  reason: string | null;
}

export type ResearchRunOrigin = 'findings' | 'topic';
export type ResearchRunStatus =
  | 'awaiting-approval'
  | 'importing'
  | 'verifying'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'dismissed'
  | 'empty';
export type ResearchFindingVerificationStatus =
  | 'pending'
  | 'fixed'
  | 'residual'
  | 'unverifiable';
export type ResearchCandidateDecision = 'pending' | 'approved' | 'rejected';
export type ResearchCandidateIngestStatus =
  | 'pending'
  | 'fetching'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed';

/** Research provenance 仓储行契约；JSON 字段保持原始字符串，由 service 显式解析。 */
export interface ResearchRunRow {
  id: string;
  subjectId: SubjectId;
  researchJobId: string;
  origin: ResearchRunOrigin;
  lintJobId: string | null;
  topic: string | null;
  topicsJson: string;
  queriesJson: string;
  candidateSetHash: string;
  status: ResearchRunStatus;
  version: number;
  verificationLintJobId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorJson: string | null;
}

export interface ResearchRunFindingRow {
  runId: string;
  findingId: string;
  snapshotJson: string;
  verificationStatus: ResearchFindingVerificationStatus;
  verifiedAt: string | null;
  verificationSnapshotJson: string | null;
}

export interface ResearchCandidateRow {
  id: string;
  runId: string;
  normalizedUrl: string;
  snapshotJson: string;
  rank: number;
  decision: ResearchCandidateDecision;
  approvalId: string | null;
  decidedAt: string | null;
}

export interface ResearchApprovalRow {
  id: string;
  runId: string;
  selectedCandidateIdsJson: string;
  payloadHash: string;
  idempotencyKey: string;
  coordinatorJobId: string;
  createdAt: string;
}

export interface ResearchCandidateIngestRow {
  approvalId: string;
  candidateId: string;
  runId: string;
  normalizedUrl: string;
  status: ResearchCandidateIngestStatus;
  sourceId: string | null;
  ingestJobId: string | null;
  operationIdsJson: string;
  touchedPagesJson: string;
  commitSha: string | null;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorJson: string | null;
}

/** 持久化候选快照；ID 由 run 与规范化 URL 稳定派生。 */
export interface ResearchCandidateSnapshot extends ResearchCandidate {
  id: string;
  normalizedUrl: string;
  rank: number;
}

/** Ingest 终态物化的页面改动；系统页保留审计但不作为 finding 已修复证据。 */
export interface ResearchTouchedPage {
  slug: string;
  action: 'created' | 'updated';
  system: boolean;
}

export interface ResearchFindingView {
  findingId: string;
  finding: EnrichedLintFinding;
  verificationStatus: ResearchFindingVerificationStatus;
  verifiedAt: string | null;
  verificationFinding: EnrichedLintFinding | null;
}

export interface ResearchCandidateDeliveryView {
  status: ResearchCandidateIngestStatus;
  sourceId: string | null;
  ingestJobId: string | null;
  operationIds: string[];
  touchedPages: ResearchTouchedPage[];
  commitSha: string | null;
  attemptCount: number;
  completedAt: string | null;
  error: { code?: string; message: string } | null;
}

export interface ResearchCandidateView extends ResearchCandidateSnapshot {
  decision: ResearchCandidateDecision;
  delivery: ResearchCandidateDeliveryView | null;
}

export interface ResearchApprovalView {
  id: string;
  selectedCandidateIds: string[];
  coordinatorJobId: string;
  createdAt: string;
}

export interface ResearchRunView {
  id: string;
  subjectId: SubjectId;
  researchJobId: string;
  origin: ResearchRunOrigin;
  lintJobId: string | null;
  topic: string | null;
  topics: string[];
  queries: string[];
  candidateSetHash: string;
  status: ResearchRunStatus;
  version: number;
  verificationLintJobId: string | null;
  findings: ResearchFindingView[];
  candidates: ResearchCandidateView[];
  approval: ResearchApprovalView | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: { code?: string; message: string } | null;
}

export type ResearchApiErrorCode =
  | 'RESEARCH_RUN_NOT_FOUND'
  | 'RESEARCH_RUN_STALE'
  | 'RESEARCH_ALREADY_APPROVED'
  | 'RESEARCH_IDEMPOTENCY_CONFLICT'
  | 'RESEARCH_SELECTION_INVALID'
  | 'RESEARCH_RUN_NOT_APPROVABLE'
  | 'RESEARCH_RUN_NOT_RETRYABLE';

export interface ResearchApiError {
  error: string;
  code: ResearchApiErrorCode;
  run?: ResearchRunView;
}

/** T3.2 待研究问题队列条目（Ask AI 未命中信号 + 手动添加）。 */
export interface ResearchBacklogEntry {
  id: string;
  subjectId: SubjectId;
  question: string;
  source: 'ask-ai' | 'manual';
  status: 'open' | 'researched' | 'dismissed';
  researchJobId: string | null;
  createdAt: string;
}

export interface LintFinding {
  type: 'broken-link' | 'orphan' | 'missing-frontmatter' | 'stale-source' | 'contradiction' | 'missing-crossref' | 'coverage-gap' | 'orphan-source' | 'thin-page';
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string;
  description: string;
  suggestedFix: string | null;
  /** 语义 finding 的规范目标；missing-crossref / coverage-gap 经服务端验证后必有。 */
  targetSlug?: string;
  /** 语义 finding 的逐页原文字面证据；旧快照可缺失。 */
  evidence?: LintFindingEvidence[];
  /** 来源相关 finding 可用：关联 source 的 DB id。 */
  sourceId?: string;
  /** 来源相关 finding 可用：source 文件名（pageSlug 为空时的展示替代）。 */
  sourceFilename?: string;
  /** orphan-source 专属：关联的 failed ingest job id；查无 job / job 非 failed 时为 null。 */
  failedJobId?: string | null;
}

export interface LintFindingEvidence {
  pageSlug: string;
  quote: string;
}

export interface EnrichedLintFinding extends LintFinding {
  id: string;
  subjectId: SubjectId;
  subjectSlug: string;
}

export interface LintLatestResult {
  jobId: string | null;
  ranAt: string | null;
  bySeverity: { critical: number; warning: number; info: number };
  findings: EnrichedLintFinding[];
}

/** Fix/Curate 完成后用于定向协调原 Health 快照的 lint 验证上下文。 */
export interface LintVerificationRequest {
  baselineLintJobId: string;
  remediationJobId: string;
}

export type RemediationStatus =
  | 'fixed'
  | 'queued'
  | 'awaiting-approval'
  | 'skipped'
  | 'failed';
export type RemediationWorkflow =
  | 'fix'
  | 'curate'
  | 'research'
  | 're-ingest'
  | 'source-review';
export type RemediationActionType =
  | 'fix'
  | 'curate'
  | 'research'
  | 're-ingest'
  | 'review-source';

export interface RemediationAction {
  type: RemediationActionType;
  label: string;
  destructive: false;
  href?: string;
}

export interface RemediationPlan {
  findingId: string;
  workflow: RemediationWorkflow;
  status: RemediationStatus;
  actions: RemediationAction[];
  reason: string;
  jobId?: string;
}

export interface RemediationContext {
  lintJobId: string;
  findingIds: string[];
  action: Exclude<RemediationActionType, 'review-source'>;
}

export interface HealthSnapshot extends LintLatestResult {
  remediations: Record<string, RemediationPlan>;
  recentOutcomes: Record<string, RemediationStatus>;
}

/** Fix / Curate 写后定向校验的实际 operation 范围。 */
export interface PostconditionScope {
  jobId: string;
  subjectId: SubjectId;
  createdSlugs: string[];
  updatedSlugs: string[];
  deletedSlugs: string[];
  touchedSlugs: string[];
  operationIds: string[];
}

export type PostconditionFindingType =
  | 'broken-link'
  | 'dangling-incoming-link'
  | 'orphan-page'
  | 'dangling-page-source'
  | 'contradiction'
  | 'missing-crossref'
  | 'verification-error';

export interface PostconditionFinding {
  type: PostconditionFindingType;
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string | null;
  description: string;
  relatedSlugs?: string[];
}

export type PostconditionSemanticStatus =
  | 'not-needed'
  | 'clean'
  | 'residual'
  | 'failed';

export interface PostconditionReport {
  status: 'clean' | 'residual';
  checkedAt: string;
  scope: PostconditionScope;
  residualFindings: PostconditionFinding[];
  semanticStatus: PostconditionSemanticStatus;
  verificationError: string | null;
}

export interface ChangesetEntry {
  action: 'create' | 'update' | 'delete';
  path: string;
  content: string | null;
  /** 新 canonical 页面由哪个旧路径迁移而来；仅允许出现在 wiki create entry。 */
  movedFromPath?: string;
  /** 受 Saga 管理但不属于页面索引的 vault 辅助文件（当前仅 source sidecar）。 */
  auxiliary?: boolean;
}

export interface Changeset {
  id: string;
  jobId: string;
  subjectId: SubjectId;
  subjectSlug: string;
  /** 规划同步写时领取的 Subject 版本；worker 内部写可留空并依赖 active-job guard。 */
  mutationEpoch?: number | null;
  entries: ChangesetEntry[];
  preHead: string;
  postHead: string | null;
  status: 'pending' | 'applied' | 'rolled-back';
}

export interface HistoryAffectedPage {
  slug: string;
  action: 'create' | 'update' | 'delete';
}

export interface HistoryEntry {
  id: string;             // operation id
  sha: string | null;     // postHead
  date: string | null;    // commit ISO 时间；git 取不到则 null
  type: string;           // 'ingest'|'curate'|'save-to-wiki'|'edit'|'delete'（merge/split 现归 curate）
  message: string;        // commit message（含 [subject:<slug>] 前缀，原样）
  affectedPages: HistoryAffectedPage[];
  status: 'applied' | 'reverted';
}

export interface HistoryListInput {
  slug?: string;
  limit?: number;
}

export interface HistoryListResult {
  entries: HistoryEntry[];
}

export interface HistoryDiffInput {
  operationId: string;
}

export interface HistoryDiffResult {
  operationId: string;
  status: 'applied' | 'reverted';
  affectedPages: HistoryAffectedPage[];
  diff: string;
}

export interface HistoryRevertInput {
  operationId: string;
}

export interface Conversation {
  id: string;
  subjectId: SubjectId;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: WikiCitation[] | null;
  createdAt: string;
}

export type PendingActionOperation =
  | 'create'
  | 'update'
  | 'patch'
  | 'delete'
  | 'reenrich'
  | 'metadata-patch'
  | 'link-ensure'
  | 'history-revert'
  | 'workflow-reenrich-start'
  | 'workflow-research-start'
  | 'workflow-cancel'
  | 'move'
  | 'tag-batch';

export type TagBatchAction = 'rename' | 'merge' | 'delete';

export interface TagBatchInput {
  action: TagBatchAction;
  sourceTag: string;
  targetTag?: string;
}

export interface TagBatchResult extends TagBatchInput {
  updatedPages: string[];
}

export type PendingActionStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'applied'
  | 'rejected'
  | 'expired'
  | 'failed';

export type PreviewChangeInput =
  | {
      operation: 'create';
      payload: { title: string; body: string; summary?: string; tags?: string[] };
    }
  | {
      operation: 'update';
      payload: { slug: string; title?: string; body: string; summary?: string; tags?: string[] };
    }
  | {
      operation: 'patch';
      payload: { slug: string; edits: Array<{ oldString: string; newString: string }> };
    }
  | { operation: 'delete'; payload: { slug: string } }
  | { operation: 'reenrich'; payload: { slug: string } }
  | { operation: 'metadata-patch'; payload: MetadataPatchInput }
  | { operation: 'link-ensure'; payload: LinkEnsureInput }
  | { operation: 'move'; payload: MovePageInput };

export type TagBatchPreviewInput = { operation: 'tag-batch'; payload: TagBatchInput };

export interface MovePageInput {
  slug: string;
  newSlug: string;
}

export type WorkflowPreviewInput =
  | { operation: 'workflow-reenrich-start'; payload: { slug: string } }
  | { operation: 'workflow-research-start'; payload: { topic: string } }
  | { operation: 'workflow-cancel'; payload: { jobId: string } };

export interface PendingActionPreview {
  kind: 'page-change' | 'workflow';
  preHead: string;
  summary: string;
  affectedPages: Array<{
    slug: string;
    action: 'create' | 'update' | 'delete';
  }>;
  diff: string | null;
  warnings: string[];
}

export interface PendingActionView extends PendingActionPreview {
  actionId: string;
  conversationId: string | null;
  operation: PendingActionOperation;
  status: PendingActionStatus;
  expiresAt: string;
  operationId: string | null;
  jobId: string | null;
  error: { code: string; message: string } | null;
}

export const AugmentationLevelSchema = z.enum(['off', 'light', 'standard', 'deep']);

export const DEFAULT_WIKI_LANGUAGE = 'English';

export const WikiLanguageSchema = z
  .string()
  .trim()
  .min(1, 'Wiki language must be a non-empty language name (e.g. "English", "Chinese", "日本語")')
  .max(64, 'Wiki language must be 64 characters or fewer')
  .regex(
    /^[^\n\r`*#\[\]<>]+$/,
    'Wiki language must not contain newlines or markdown control characters',
  );

export const DEFAULT_AGENT_MAX_STEPS = 25;
export const DEFAULT_AGENT_MAX_TOKENS_PER_JOB = 1_200_000;
export const DEFAULT_AGENT_MAX_PARALLEL_SUB_AGENTS = 3;
export const DEFAULT_AGENT_TASK_ROUTER_MODE = 'frontmatter-override' as const;
export const DEFAULT_AGENT_AUTO_CURATE = true;

// ── Ingest 并发（worker 每轮 tick 实时读取；1 = 行为等同串行现状）─────────
export const DEFAULT_INGEST_CONCURRENCY = 2;
export const IngestConcurrencySchema = z.number().int().min(1).max(4);

export const AgentTaskRouterModeSchema = z.enum(['task-router-only', 'frontmatter-override']);

export const AgentMaxStepsSchema = z.number().int().min(1).max(200);
export const AgentMaxTokensPerJobSchema = z.number().int().min(10_000).max(5_000_000);
export const AgentMaxParallelSubAgentsSchema = z.number().int().min(1).max(10);
export const AgentAutoCurateSchema = z.boolean();

export type AgentTaskRouterMode = z.infer<typeof AgentTaskRouterModeSchema>;

export const DEFAULT_WEB_SEARCH_PROVIDER = 'tavily' as const;
export const DEFAULT_WEB_SEARCH_API_KEY = '';
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;

export const WebSearchProviderSchema = z.enum(['tavily']);
// 允许空串：空 = 未配置 / 关闭联网核查（优雅降级纯自检）
export const WebSearchApiKeySchema = z.string().trim().max(200);
export const WebSearchMaxResultsSchema = z.number().int().min(1).max(10);

export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>;

// ── P5 维护层：维护设置 ────────────────────────────────────────────────────
// maintenanceEnabled 默认 false：维护层默认关闭，避免静默烧 token。
// maintenanceLastSweepAt 是运行态内部时间戳，不进 AppSettings（仅 settings-repo 内部读写）。

export const DEFAULT_MAINTENANCE_ENABLED = false;
export const DEFAULT_MAINTENANCE_SWEEP_INTERVAL_HOURS = 24;
export const DEFAULT_MAINTENANCE_MAX_PAGES_PER_SWEEP = 5;

export const MaintenanceEnabledSchema = z.boolean();
export const MaintenanceSweepIntervalHoursSchema = z.number().int().min(1).max(168);
export const MaintenanceMaxPagesPerSweepSchema = z.number().int().min(1).max(50);
export const MaintenanceScopeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({
    mode: z.literal('subjects'),
    subjectIds: z.array(z.string().trim().min(1)).min(1).superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Subject IDs must be unique' });
      }
    }),
  }),
]);

export type MaintenanceScope = z.infer<typeof MaintenanceScopeSchema>;
export const DEFAULT_MAINTENANCE_SCOPE: MaintenanceScope = { mode: 'all' };

/** 维护层只读运行态（`GET /api/maintenance/status`）；非设置，故不进 AppSettings。 */
export interface MaintenanceStatus {
  enabled: boolean;
  /** 上次 sweep 时间（ISO）；从未扫描为 null。 */
  lastSweepAt: string | null;
  sweepIntervalHours: number;
  /** 当前维护范围内到期且未毕业的页数（与 sweep 同口径）。 */
  dueCount: number;
}

export interface AppSettings {
  wikiLanguage: string;
  agentMaxSteps: number;
  agentMaxTokensPerJob: number;
  agentMaxParallelSubAgents: number;
  agentTaskRouterMode: AgentTaskRouterMode;
  agentAutoCurate: boolean;
  ingestConcurrency: number;
  webSearchProvider: WebSearchProvider;
  webSearchApiKey: string;
  webSearchMaxResults: number;
  maintenanceEnabled: boolean;
  maintenanceScope: MaintenanceScope;
  maintenanceSweepIntervalHours: number;
  maintenanceMaxPagesPerSweep: number;
}

export const AppSettingsSchema = z.object({
  wikiLanguage: WikiLanguageSchema,
  agentMaxSteps: AgentMaxStepsSchema,
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema,
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema,
  agentTaskRouterMode: AgentTaskRouterModeSchema,
  agentAutoCurate: AgentAutoCurateSchema,
  ingestConcurrency: IngestConcurrencySchema,
  webSearchProvider: WebSearchProviderSchema,
  webSearchApiKey: WebSearchApiKeySchema,
  webSearchMaxResults: WebSearchMaxResultsSchema,
  maintenanceEnabled: MaintenanceEnabledSchema,
  maintenanceScope: MaintenanceScopeSchema,
  maintenanceSweepIntervalHours: MaintenanceSweepIntervalHoursSchema,
  maintenanceMaxPagesPerSweep: MaintenanceMaxPagesPerSweepSchema,
});

// ── P5 维护层：页面成熟度 ──────────────────────────────────────────────────

// 注：'dormant' 当前为保留/未使用状态。nextMaturity 仅发出 'active'/'graduated'，
// bumpNeighbor 也始终复活为 'active'。为未来冬眠模式预留，暂不从联合类型中移除。
export type MaturityState = 'active' | 'dormant' | 'graduated';

/** 每页成熟度（维护层 P5）。spacing 阶梯由 maintenance-policy 推进。 */
export interface PageMaturity {
  subjectId: SubjectId;
  slug: string;
  passes: number;
  lastEnrichedAt: string | null;
  intervalDays: number;
  nextDueAt: string;
  state: MaturityState;
  priority: number;
  updatedAt: string;
}

// ── Cognitive Lens（读时内容重塑）─────────────────────────────────
// 读者表达偏好（client 侧纯类型；server 侧 zod 真源在 server/profile/style.ts，
// 两处枚举字面量必须一致，由 style.ts 的编译期断言守卫防漂移）。
export type LensReadingLevel = 'beginner' | 'intermediate' | 'advanced';
export type LensVerbosity = 'terse' | 'balanced' | 'thorough';
export type LensExampleDensity = 'few' | 'some' | 'many';
export type LensFormality = 'casual' | 'neutral' | 'formal';

export interface StylePrefs {
  readingLevel: LensReadingLevel;
  verbosity: LensVerbosity;
  exampleDensity: LensExampleDensity;
  formality: LensFormality;
}

export interface UserProfileDTO {
  backgroundSummary: string;
  stylePrefs: StylePrefs;
  version: number;
  onboardedAt: string | null;
}

// ---------------------------------------------------------------------------
// LLM 用量统计（设置页 Usage 面板）
// ---------------------------------------------------------------------------

/** Usage 统计时间窗。 */
export type UsageWindow = '7d' | '30d' | 'all';

/** GET /api/usage 聚合行：按 (task, model) 分组。 */
export interface UsageSummaryRow {
  task: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
