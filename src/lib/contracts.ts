import { z } from 'zod';

export type SubjectId = string;

export interface Subject {
  id: SubjectId;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/subjects` 列表项：Subject 摘要 + 页面计数 */
export interface SubjectListEntry {
  id: SubjectId;
  slug: string;
  name: string;
  description: string;
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
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'merge' | 'split' | 'embed-index';
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

/**
 * A source document a page was written from, prepared for the split reading
 * view. Content is delivered in one of `pages` (pdf sheets) / `text` / `html`
 * depending on `format`, and may be capped (`truncated`) for large files.
 */
export interface PageSourceDoc {
  id: string;
  name: string;
  format: PageSourceFormat;
  added: string;
  meta?: string;
  truncated?: boolean;
  pages?: string[];
  text?: string;
  html?: string;
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

export interface LintFinding {
  type: 'broken-link' | 'orphan' | 'missing-frontmatter' | 'stale-source' | 'contradiction' | 'missing-crossref' | 'coverage-gap';
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string;
  description: string;
  suggestedFix: string | null;
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
  type: string;           // 'ingest'|'merge'|'split'|'save-to-wiki'|'edit'|'delete'
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
export const DEFAULT_AGENT_MCP_LIFECYCLE = 'lazy' as const;
export const DEFAULT_AGENT_TASK_ROUTER_MODE = 'frontmatter-override' as const;

export const AgentMcpLifecycleSchema = z.enum(['eager', 'lazy', 'per-job']);
export const AgentTaskRouterModeSchema = z.enum(['task-router-only', 'frontmatter-override']);

export const AgentMaxStepsSchema = z.number().int().min(1).max(200);
export const AgentMaxTokensPerJobSchema = z.number().int().min(10_000).max(5_000_000);
export const AgentMaxParallelSubAgentsSchema = z.number().int().min(1).max(10);

export type AgentMcpLifecycle = z.infer<typeof AgentMcpLifecycleSchema>;
export type AgentTaskRouterMode = z.infer<typeof AgentTaskRouterModeSchema>;

export const DEFAULT_WEB_SEARCH_PROVIDER = 'tavily' as const;
export const DEFAULT_WEB_SEARCH_API_KEY = '';
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;

export const WebSearchProviderSchema = z.enum(['tavily']);
// 允许空串：空 = 未配置 / 关闭联网核查（优雅降级纯自检）
export const WebSearchApiKeySchema = z.string().trim().max(200);
export const WebSearchMaxResultsSchema = z.number().int().min(1).max(10);

export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>;

export interface AppSettings {
  wikiLanguage: string;
  agentMaxSteps: number;
  agentMaxTokensPerJob: number;
  agentMaxParallelSubAgents: number;
  agentMcpLifecycle: AgentMcpLifecycle;
  agentTaskRouterMode: AgentTaskRouterMode;
  webSearchProvider: WebSearchProvider;
  webSearchApiKey: string;
  webSearchMaxResults: number;
}

export const AppSettingsSchema = z.object({
  wikiLanguage: WikiLanguageSchema,
  agentMaxSteps: AgentMaxStepsSchema,
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema,
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema,
  agentMcpLifecycle: AgentMcpLifecycleSchema,
  agentTaskRouterMode: AgentTaskRouterModeSchema,
  webSearchProvider: WebSearchProviderSchema,
  webSearchApiKey: WebSearchApiKeySchema,
  webSearchMaxResults: WebSearchMaxResultsSchema,
});
