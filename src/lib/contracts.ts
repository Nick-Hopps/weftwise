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
  type: 'ingest' | 'lint' | 'save-to-wiki';
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

export interface Source {
  id: string;
  filename: string;
  contentHash: string;
  parsedAt: string | null;
  metadataJson: string;
  subjectId: SubjectId;
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
export const DEFAULT_AGENT_MAX_TOKENS_PER_JOB = 500_000;
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

export interface AppSettings {
  wikiLanguage: string;
  agentMaxSteps: number;
  agentMaxTokensPerJob: number;
  agentMaxParallelSubAgents: number;
  agentMcpLifecycle: AgentMcpLifecycle;
  agentTaskRouterMode: AgentTaskRouterMode;
}

export const AppSettingsSchema = z.object({
  wikiLanguage: WikiLanguageSchema,
  agentMaxSteps: AgentMaxStepsSchema,
  agentMaxTokensPerJob: AgentMaxTokensPerJobSchema,
  agentMaxParallelSubAgents: AgentMaxParallelSubAgentsSchema,
  agentMcpLifecycle: AgentMcpLifecycleSchema,
  agentTaskRouterMode: AgentTaskRouterModeSchema,
});
