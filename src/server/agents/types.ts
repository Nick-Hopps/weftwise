import type { ZodSchema } from 'zod';
import type { Job, Subject, ChangesetEntry, CheckpointProgress } from '@/lib/contracts';
import type { ToolContext } from './tools/tool-context';

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

export type ToolSource = 'builtin';
export type ToolSideEffect = 'none' | 'propose' | 'enqueue' | 'destructive' | 'create' | 'update' | 'merge' | 'split';

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  source: ToolSource;
  description: string;
  inputSchema: ZodSchema<I>;
  outputSchema: ZodSchema<O>;
  sideEffect: ToolSideEffect;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
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

/** 断点续传句柄：内存索引 + 落盘双写；缺省（undefined）时 orchestrator 行为与现状一致。 */
export interface IngestCheckpoint {
  getChunkSummary(key: string): string | undefined;
  putChunkSummary(key: string, summary: string): void;
  getPlan(): unknown | undefined;
  putPlan(output: unknown): void;
  getWriterPage(slug: string): ChangesetEntry | undefined;   // slug = plan page 身份
  putWriterPage(slug: string, entry: ChangesetEntry): void;
  getEnricherPage(slug: string): ChangesetEntry | undefined;
  putEnricherPage(slug: string, entry: ChangesetEntry): void;
  getVerifierPage(slug: string): ChangesetEntry | undefined;
  putVerifierPage(slug: string, entry: ChangesetEntry): void;
  getSupplementPage(slug: string): ChangesetEntry | undefined;
  putSupplementPage(slug: string, entry: ChangesetEntry): void;
  /** T1.6：撤销某阶段某页已落盘的检查点条目（WriterConflict 场景：冲突页不得残留可续传的坏检查点）。 */
  deleteStagePage(kind: 'writer-page' | 'enricher-page' | 'verifier-page' | 'supplement-page', slug: string): void;
  /** ⑨ 核查累积的网页引用源（整张去重后列表，单 blob 持久化）；续传时 rehydrate 进 ctx.citedSources。 */
  getCitedSources(): CitedSource[];
  putCitedSources(list: CitedSource[]): void;
  hasAny(): boolean;
  progress(): CheckpointProgress;
  clear(): void;
}

/** chunkStore 中的块全文（全文唯一存放处，绝不进 carry/prompt）。 */
export interface StoredChunk {
  sourceId: string;
  id: string;
  heading: string;
  text: string;
}

/** carry 中流转的轻量块引用；content 在小路径=全文、大路径=摘要。 */
export interface ChunkRef {
  key: string; // `${sourceId}:${id}`
  sourceId: string;
  id: string;
  heading: string;
  content: string;
}

/** ⑨ 核查阶段引用的网页源（跨页按 url 去重；finalize 时导入为 source）。 */
export interface CitedSource {
  url: string;
  title: string;
  citedBy: string[];        // 引用该网页的页面 slug 列表
  fallbackContent: string;  // extract 失败时兜底的正文（取自搜索 snippet）
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
  /** 块全文存放处；key = `${sourceId}:${chunkId}`。 */
  chunkStore: Map<string, StoredChunk>;
  /** Snapshot from settings-repo, captured at root-run start. */
  budgetSnapshot: AgentBudget;
  /** 断点续传句柄；仅 ingest 注入，缺省时不续传。 */
  checkpoint?: IngestCheckpoint;
  /** ⑨ 核查阶段累积的网页引用源；仅 ingest 注入（Map<url, CitedSource>）。 */
  citedSources?: Map<string, CitedSource>;
  /**
   * T1.5：fanout 每项启动前的 token 预扣估算函数（入参=本次 fanout 的项数，出参=单项预扣量）。
   * ingest 注入时复用 `ingest-prep.ts::estimatePerPageTokens`（按预检总估算折算）；
   * 未注入（如 re-enrich 等单页/小规模场景）时 orchestrator 回退为
   * `maxTokensPerJob / itemCount` 的均分估算，不新造第二套估算体系。
   */
  estimateFanoutReserve?: (itemCount: number) => number;
  /**
   * T2.2：fanout 每页 existingPages 检索式子集裁剪的检索函数（入参=subjectId/查询文本/topN，
   * 出参=按相关度排序的 slug 列表）。未注入时 buildFanoutInput 跳过检索，仅保留自身条目 +
   * wikilink 目标（最小降级集合）——不会导致 fanout 失败。ingest-service 注入时复用
   * `search/hybrid-retrieval.ts::hybridRankSlugs`（FTS+向量 RRF，未配置嵌入自动回落纯 FTS）。
   */
  retrieveRelevantPages?: (subjectId: string, query: string, topN: number) => Promise<string[]>;
}

/** reserve() 返回的预留句柄；settle() 用它退回对应额度。 */
export interface BudgetReservation {
  readonly estimated: number;
}

// Forward-declared interfaces; concrete classes live in their own files.
export interface BudgetTracker {
  chargeTokens(n: number): void;
  assertWithin(): void;
  readonly tokensUsed: number;
  /**
   * 预扣 `estimated` token 额度（T1.5：fanout 并发派发前调用，避免所有并发实例
   * 在任何一页记账前就都通过 assertWithin 闸门）。额度不足时等待其他预留 settle
   * 释放空间；若排队后即便所有在飞预留都结算完仍不够，拒绝并抛 BudgetExceededError。
   */
  reserve(estimated: number): Promise<BudgetReservation>;
  /** 结算一笔预留：释放其占用的额度，唤醒排队等待者。actual 由调用方自行记账（见 budget.ts 顶部注释）。 */
  settle(handle: BudgetReservation, actual: number): void;
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
