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

export type TitleResolver = (title: string) => string | undefined;

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

export interface Job {
  id: string;
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'embed-index' | 'curate' | 're-enrich' | 'fix' | 'research';
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
  citations: { pageSlug: string; excerpt: string }[];
  savedAsPage: string | null;
}

/** research job 输出的单条候选：只发现不写入，确认后经现有 /api/ingest urls[] 收口。 */
export interface ResearchCandidate {
  url: string;
  title: string;
  snippet: string;
  /** triage 评分 0-3；triage 降级时为 null（按搜索排名前 3 未评分）。 */
  score: number | null;
  reason: string | null;
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
  type: 'broken-link' | 'orphan' | 'missing-frontmatter' | 'stale-source' | 'contradiction' | 'missing-crossref' | 'coverage-gap' | 'orphan-source';
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string;
  description: string;
  suggestedFix: string | null;
  /** orphan-source 专属：孤儿 source 的 DB id。 */
  sourceId?: string;
  /** orphan-source 专属：source 文件名（pageSlug 为空时的展示替代）。 */
  sourceFilename?: string;
  /** orphan-source 专属：关联的 failed ingest job id；查无 job / job 非 failed 时为 null。 */
  failedJobId?: string | null;
}

export interface EnrichedLintFinding extends LintFinding {
  subjectId: SubjectId;
  subjectSlug: string;
}

export interface LintLatestResult {
  jobId: string | null;
  ranAt: string | null;
  bySeverity: { critical: number; warning: number; info: number };
  findings: EnrichedLintFinding[];
}

export interface ChangesetEntry {
  action: 'create' | 'update' | 'delete';
  path: string;
  content: string | null;
}

export interface Changeset {
  id: string;
  jobId: string;
  subjectId: SubjectId;
  subjectSlug: string;
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
  citations: { pageSlug: string; excerpt: string }[] | null;
  createdAt: string;
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

/** 维护层只读运行态（`GET /api/maintenance/status`）；非设置，故不进 AppSettings。 */
export interface MaintenanceStatus {
  enabled: boolean;
  /** 上次 sweep 时间（ISO）；从未扫描为 null。 */
  lastSweepAt: string | null;
  sweepIntervalHours: number;
  /** 当前全量到期且未毕业的页数（跨主题，与 sweep 同口径）。 */
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
