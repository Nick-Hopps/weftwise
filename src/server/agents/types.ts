import type { ZodSchema } from 'zod';
import type { Job, Subject, ChangesetEntry } from '@/lib/contracts';

export interface AgentBudget {
  maxSteps: number;
  maxTokensPerJob: number;
  maxParallelSubAgents: number;
}

export interface SkillModelOverride {
  profile?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  tools: string[];
  canDispatch: string[];
  systemPrompt: string;
  outputSchema?: ZodSchema;
  model?: SkillModelOverride;
  budget?: Partial<AgentBudget>;
}

export type ToolSource = 'builtin' | 'mcp' | 'dispatch';
export type ToolSideEffect = 'none' | 'commit';

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  source: ToolSource;
  description: string;
  inputSchema: ZodSchema<I>;
  outputSchema: ZodSchema<O>;
  sideEffect: ToolSideEffect;
  handler: (input: I, ctx: AgentContext) => Promise<O>;
}

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'budget-exceeded';

export interface AgentRun {
  id: string;
  jobId: string;
  subjectId: string;
  parentRunId: string | null;
  skillId: string;
  status: AgentRunStatus;
  startedAt: number;
  endedAt?: number;
  tokensUsed: number;
  stepCount: number;
}

export type AgentStep =
  | { kind: 'thinking'; runId: string; index: number; text: string; tokensIn: number; tokensOut: number }
  | { kind: 'tool-call'; runId: string; index: number; tool: string; input: unknown; output: unknown; durationMs: number; tokensIn?: number; tokensOut?: number; error?: string }
  | { kind: 'sub-agent-dispatch'; runId: string; index: number; childRunId: string; skillId: string }
  | { kind: 'final'; runId: string; index: number; output: unknown; tokensIn: number; tokensOut: number };

export interface PendingChangeset {
  entries: ChangesetEntry[];
}

export interface AgentContext {
  job: Job;
  subject: Subject;
  emit: (eventType: string, message: string, data?: Record<string, unknown>) => void;
  budget: BudgetTracker;
  overlay: OverlayVault;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  rootRunId: string;
  parentRunId: string | null;
  cancelled: () => boolean;
  committed: { value: boolean };
  pending: PendingChangeset;
  /** Snapshot from settings-repo, captured at root-run start. */
  budgetSnapshot: AgentBudget;
}

// Forward-declared interfaces; concrete classes live in their own files.
export interface BudgetTracker {
  chargeTokens(n: number): void;
  assertWithin(): void;
  readonly tokensUsed: number;
}

/** 单 agent 实例内的 step 计数器（防单实例失控循环；job 级总量防线是 token）。 */
export interface RunStepTracker {
  chargeStep(): void;
  readonly stepCount: number;
}

export interface OverlayVault {
  readPage(subjectSlug: string, slug: string): Promise<{ markdown: string } | null>;
  search(subjectSlug: string, query: string): Promise<Array<{ slug: string; title: string; summary: string; source: 'overlay' | 'store' }>>;
  putEntries(entries: ChangesetEntry[]): void;
  snapshot(): OverlayVault;
}

export interface ToolRegistry {
  register(tool: ToolDef): void;
  resolve(skillTools: string[]): ToolDef[];
  get(name: string): ToolDef | undefined;
}

export interface SkillRegistry {
  get(id: string): SkillTemplate | undefined;
  list(): SkillTemplate[];
  degraded(): Array<{ skillId: string; errors: string[] }>;
}
