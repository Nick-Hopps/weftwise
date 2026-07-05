import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import { appSettings } from '../schema';
import {
  DEFAULT_WIKI_LANGUAGE,
  WikiLanguageSchema,
  AgentMaxParallelSubAgentsSchema,
  AgentMaxStepsSchema,
  AgentMaxTokensPerJobSchema,
  AgentTaskRouterModeSchema,
  DEFAULT_AGENT_MAX_PARALLEL_SUB_AGENTS,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_MAX_TOKENS_PER_JOB,
  DEFAULT_AGENT_TASK_ROUTER_MODE,
  AgentAutoCurateSchema,
  DEFAULT_AGENT_AUTO_CURATE,
  type AgentTaskRouterMode,
  DEFAULT_INGEST_CONCURRENCY,
  IngestConcurrencySchema,
  WebSearchProviderSchema,
  WebSearchApiKeySchema,
  WebSearchMaxResultsSchema,
  DEFAULT_WEB_SEARCH_PROVIDER,
  DEFAULT_WEB_SEARCH_API_KEY,
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  type WebSearchProvider,
  MaintenanceEnabledSchema,
  MaintenanceSweepIntervalHoursSchema,
  MaintenanceMaxPagesPerSweepSchema,
  DEFAULT_MAINTENANCE_ENABLED,
  DEFAULT_MAINTENANCE_SWEEP_INTERVAL_HOURS,
  DEFAULT_MAINTENANCE_MAX_PAGES_PER_SWEEP,
} from '@/lib/contracts';

const KEY_WIKI_LANGUAGE = 'wikiLanguage';
const KEY_AGENT_MAX_STEPS = 'agentMaxSteps';
const KEY_AGENT_MAX_TOKENS_PER_JOB = 'agentMaxTokensPerJob';
const KEY_AGENT_MAX_PARALLEL_SUB_AGENTS = 'agentMaxParallelSubAgents';
const KEY_AGENT_TASK_ROUTER_MODE = 'agentTaskRouterMode';
const KEY_AGENT_AUTO_CURATE = 'agentAutoCurate';
const KEY_INGEST_CONCURRENCY = 'ingestConcurrency';

const KEY_WEB_SEARCH_PROVIDER = 'webSearchProvider';
const KEY_WEB_SEARCH_API_KEY = 'webSearchApiKey';
const KEY_WEB_SEARCH_MAX_RESULTS = 'webSearchMaxResults';

function readKey(key: string): string | undefined {
  const db = getDb();
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  return row?.value;
}

function writeKey(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now },
    })
    .run();
}

/**
 * Returns the configured wiki language. Falls back to DEFAULT_WIKI_LANGUAGE
 * when no row has been written yet. Reads the DB on every call so changes
 * made via the settings dialog take effect on the next LLM task without a
 * worker restart.
 */
export function getWikiLanguage(): string {
  return readKey(KEY_WIKI_LANGUAGE) ?? DEFAULT_WIKI_LANGUAGE;
}

/**
 * Persists a new wiki language. Validates via WikiLanguageSchema (throws on
 * empty / whitespace / over-long input). Returns the canonical (trimmed) value.
 */
export function setWikiLanguage(value: string): string {
  const validated = WikiLanguageSchema.parse(value);
  writeKey(KEY_WIKI_LANGUAGE, validated);
  return validated;
}

// ─────────────────────────────────────────────────────────────────
// Agent Runtime Configuration Keys (5 new settings)
// ─────────────────────────────────────────────────────────────────

function readNumber(key: string, fallback: number): number {
  const raw = readKey(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Returns the max agentic loop steps (1-200). Falls back to DEFAULT_AGENT_MAX_STEPS (25).
 * Reads DB on every call so changes take effect without worker restart.
 */
export function getAgentMaxSteps(): number {
  return readNumber(KEY_AGENT_MAX_STEPS, DEFAULT_AGENT_MAX_STEPS);
}

/**
 * Persists max agentic loop steps. Validates via AgentMaxStepsSchema (1-200).
 * Returns the validated value.
 */
export function setAgentMaxSteps(value: number): number {
  const v = AgentMaxStepsSchema.parse(value);
  writeKey(KEY_AGENT_MAX_STEPS, String(v));
  return v;
}

/**
 * Returns the max tokens per job (10k-5M). Falls back to DEFAULT_AGENT_MAX_TOKENS_PER_JOB (1.2M).
 * Reads DB on every call so changes take effect without worker restart.
 */
export function getAgentMaxTokensPerJob(): number {
  return readNumber(KEY_AGENT_MAX_TOKENS_PER_JOB, DEFAULT_AGENT_MAX_TOKENS_PER_JOB);
}

/**
 * Persists max tokens per job. Validates via AgentMaxTokensPerJobSchema (10k-5M).
 * Returns the validated value.
 */
export function setAgentMaxTokensPerJob(value: number): number {
  const v = AgentMaxTokensPerJobSchema.parse(value);
  writeKey(KEY_AGENT_MAX_TOKENS_PER_JOB, String(v));
  return v;
}

/**
 * Returns max parallel sub-agents (1-10). Falls back to DEFAULT_AGENT_MAX_PARALLEL_SUB_AGENTS (3).
 * Reads DB on every call so changes take effect without worker restart.
 */
export function getAgentMaxParallelSubAgents(): number {
  return readNumber(KEY_AGENT_MAX_PARALLEL_SUB_AGENTS, DEFAULT_AGENT_MAX_PARALLEL_SUB_AGENTS);
}

/**
 * Persists max parallel sub-agents. Validates via AgentMaxParallelSubAgentsSchema (1-10).
 * Returns the validated value.
 */
export function setAgentMaxParallelSubAgents(value: number): number {
  const v = AgentMaxParallelSubAgentsSchema.parse(value);
  writeKey(KEY_AGENT_MAX_PARALLEL_SUB_AGENTS, String(v));
  return v;
}

/**
 * Returns task router mode ('task-router-only' | 'frontmatter-override').
 * Falls back to DEFAULT_AGENT_TASK_ROUTER_MODE ('frontmatter-override').
 * Reads DB on every call so changes take effect without worker restart.
 */
export function getAgentTaskRouterMode(): AgentTaskRouterMode {
  const raw = readKey(KEY_AGENT_TASK_ROUTER_MODE);
  if (raw === undefined) return DEFAULT_AGENT_TASK_ROUTER_MODE;
  const parsed = AgentTaskRouterModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_AGENT_TASK_ROUTER_MODE;
}

/**
 * Persists task router mode. Validates via AgentTaskRouterModeSchema.
 * Returns the validated value.
 */
export function setAgentTaskRouterMode(value: AgentTaskRouterMode): AgentTaskRouterMode {
  const v = AgentTaskRouterModeSchema.parse(value);
  writeKey(KEY_AGENT_TASK_ROUTER_MODE, v);
  return v;
}

/**
 * Returns whether ingest auto-triggers a curation pass on success. Falls back to
 * DEFAULT_AGENT_AUTO_CURATE (true). Stored as 'true'/'false' string in app_settings.
 * Reads DB on every call so the toggle takes effect without a worker restart.
 */
export function getAgentAutoCurate(): boolean {
  const raw = readKey(KEY_AGENT_AUTO_CURATE);
  if (raw === undefined) return DEFAULT_AGENT_AUTO_CURATE;
  return raw === 'true';
}

/**
 * Persists the auto-curate toggle. Validates via AgentAutoCurateSchema.
 * Returns the validated value.
 */
export function setAgentAutoCurate(value: boolean): boolean {
  const v = AgentAutoCurateSchema.parse(value);
  writeKey(KEY_AGENT_AUTO_CURATE, String(v));
  return v;
}

/**
 * Returns ingest worker concurrency (1-4). Falls back to DEFAULT_INGEST_CONCURRENCY (2).
 * Reads DB on every call so changes take effect without worker restart.
 */
export function getIngestConcurrency(): number {
  return readNumber(KEY_INGEST_CONCURRENCY, DEFAULT_INGEST_CONCURRENCY);
}

/** Persists ingest concurrency. Validates via IngestConcurrencySchema (1-4). */
export function setIngestConcurrency(value: number): number {
  const v = IngestConcurrencySchema.parse(value);
  writeKey(KEY_INGEST_CONCURRENCY, String(v));
  return v;
}

// ─────────────────────────────────────────────────────────────────
// Web Search Backend Configuration (⑨ verifier 联网核查)
// 全 app 单实例配置；服务层每次实时读，UI 改即时生效、无需重启 worker。
// ─────────────────────────────────────────────────────────────────

export function getWebSearchProvider(): WebSearchProvider {
  const raw = readKey(KEY_WEB_SEARCH_PROVIDER);
  if (raw === undefined) return DEFAULT_WEB_SEARCH_PROVIDER;
  const parsed = WebSearchProviderSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_WEB_SEARCH_PROVIDER;
}

export function setWebSearchProvider(value: WebSearchProvider): WebSearchProvider {
  const v = WebSearchProviderSchema.parse(value);
  writeKey(KEY_WEB_SEARCH_PROVIDER, v);
  return v;
}

export function getWebSearchApiKey(): string {
  return readKey(KEY_WEB_SEARCH_API_KEY) ?? DEFAULT_WEB_SEARCH_API_KEY;
}

export function setWebSearchApiKey(value: string): string {
  const v = WebSearchApiKeySchema.parse(value);
  writeKey(KEY_WEB_SEARCH_API_KEY, v);
  return v;
}

export function getWebSearchMaxResults(): number {
  return readNumber(KEY_WEB_SEARCH_MAX_RESULTS, DEFAULT_WEB_SEARCH_MAX_RESULTS);
}

export function setWebSearchMaxResults(value: number): number {
  const v = WebSearchMaxResultsSchema.parse(value);
  writeKey(KEY_WEB_SEARCH_MAX_RESULTS, String(v));
  return v;
}

/** 一次读取三字段，供 web-search.ts 使用。 */
export function getWebSearchConfig(): {
  provider: WebSearchProvider;
  apiKey: string;
  maxResults: number;
} {
  return {
    provider: getWebSearchProvider(),
    apiKey: getWebSearchApiKey(),
    maxResults: getWebSearchMaxResults(),
  };
}

// ─────────────────────────────────────────────────────────────────
// P5 维护层设置（Maintenance Layer）
// maintenanceEnabled 默认 false：避免静默烧 token。
// maintenanceLastSweepAt 为运行态内部时间戳，不进 AppSettings/route。
// ─────────────────────────────────────────────────────────────────

const KEY_MAINTENANCE_ENABLED = 'maintenanceEnabled';
const KEY_MAINTENANCE_SWEEP_INTERVAL_HOURS = 'maintenanceSweepIntervalHours';
const KEY_MAINTENANCE_MAX_PAGES_PER_SWEEP = 'maintenanceMaxPagesPerSweep';
const KEY_MAINTENANCE_LAST_SWEEP_AT = 'maintenanceLastSweepAt';

/**
 * 返回维护层开关。默认 false（避免未配置时静默烧 token）。
 * 每次调用实时读 DB，修改后无需重启 worker。
 */
export function getMaintenanceEnabled(): boolean {
  const raw = readKey(KEY_MAINTENANCE_ENABLED);
  if (raw === undefined) return DEFAULT_MAINTENANCE_ENABLED;
  return raw === 'true';
}

/**
 * 持久化维护层开关。经 MaintenanceEnabledSchema 校验。
 */
export function setMaintenanceEnabled(value: boolean): boolean {
  const v = MaintenanceEnabledSchema.parse(value);
  writeKey(KEY_MAINTENANCE_ENABLED, v ? 'true' : 'false');
  return v;
}

/**
 * 返回扫描间隔（小时，1..168）。默认 24。
 */
export function getMaintenanceSweepIntervalHours(): number {
  return readNumber(KEY_MAINTENANCE_SWEEP_INTERVAL_HOURS, DEFAULT_MAINTENANCE_SWEEP_INTERVAL_HOURS);
}

/**
 * 持久化扫描间隔。经 MaintenanceSweepIntervalHoursSchema 校验（1..168）。
 */
export function setMaintenanceSweepIntervalHours(value: number): number {
  const v = MaintenanceSweepIntervalHoursSchema.parse(value);
  writeKey(KEY_MAINTENANCE_SWEEP_INTERVAL_HOURS, String(v));
  return v;
}

/**
 * 返回每次扫描最大页数（1..50）。默认 5。
 */
export function getMaintenanceMaxPagesPerSweep(): number {
  return readNumber(KEY_MAINTENANCE_MAX_PAGES_PER_SWEEP, DEFAULT_MAINTENANCE_MAX_PAGES_PER_SWEEP);
}

/**
 * 持久化每次扫描最大页数。经 MaintenanceMaxPagesPerSweepSchema 校验（1..50）。
 */
export function setMaintenanceMaxPagesPerSweep(value: number): number {
  const v = MaintenanceMaxPagesPerSweepSchema.parse(value);
  writeKey(KEY_MAINTENANCE_MAX_PAGES_PER_SWEEP, String(v));
  return v;
}

/**
 * 返回上次扫描完成时间（ISO 字符串）。从未扫描过时返回 null。
 * 仅供维护层 worker 内部读写，不进 AppSettings/route。
 */
export function getMaintenanceLastSweepAt(): string | null {
  return readKey(KEY_MAINTENANCE_LAST_SWEEP_AT) ?? null;
}

/**
 * 记录上次扫描完成时间（ISO 字符串）。
 */
export function setMaintenanceLastSweepAt(iso: string): void {
  writeKey(KEY_MAINTENANCE_LAST_SWEEP_AT, iso);
}
