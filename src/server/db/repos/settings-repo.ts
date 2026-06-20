import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import { appSettings } from '../schema';
import {
  DEFAULT_WIKI_LANGUAGE,
  WikiLanguageSchema,
  AgentMaxParallelSubAgentsSchema,
  AgentMaxStepsSchema,
  AgentMaxTokensPerJobSchema,
  AgentMcpLifecycleSchema,
  AgentTaskRouterModeSchema,
  DEFAULT_AGENT_MAX_PARALLEL_SUB_AGENTS,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_AGENT_MAX_TOKENS_PER_JOB,
  DEFAULT_AGENT_MCP_LIFECYCLE,
  DEFAULT_AGENT_TASK_ROUTER_MODE,
  type AgentMcpLifecycle,
  type AgentTaskRouterMode,
} from '@/lib/contracts';

const KEY_WIKI_LANGUAGE = 'wikiLanguage';
const KEY_AGENT_MAX_STEPS = 'agentMaxSteps';
const KEY_AGENT_MAX_TOKENS_PER_JOB = 'agentMaxTokensPerJob';
const KEY_AGENT_MAX_PARALLEL_SUB_AGENTS = 'agentMaxParallelSubAgents';
const KEY_AGENT_MCP_LIFECYCLE = 'agentMcpLifecycle';
const KEY_AGENT_TASK_ROUTER_MODE = 'agentTaskRouterMode';

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
 * Returns MCP lifecycle mode ('lazy' | 'eager' | 'per-job').
 * Falls back to DEFAULT_AGENT_MCP_LIFECYCLE ('lazy').
 * Reads DB on every call so changes take effect without worker restart.
 */
export function getAgentMcpLifecycle(): AgentMcpLifecycle {
  const raw = readKey(KEY_AGENT_MCP_LIFECYCLE);
  if (raw === undefined) return DEFAULT_AGENT_MCP_LIFECYCLE;
  const parsed = AgentMcpLifecycleSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_AGENT_MCP_LIFECYCLE;
}

/**
 * Persists MCP lifecycle mode. Validates via AgentMcpLifecycleSchema.
 * Returns the validated value.
 */
export function setAgentMcpLifecycle(value: AgentMcpLifecycle): AgentMcpLifecycle {
  const v = AgentMcpLifecycleSchema.parse(value);
  writeKey(KEY_AGENT_MCP_LIFECYCLE, v);
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
