import { generateObject, generateText, InvalidToolInputError, stepCountIs, type ToolSet, type ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import type { ZodSchema } from 'zod';
import type { AgentContext, SkillTemplate } from '../types';
import { resolveTask } from '../../llm/task-router';
import { resolveModel, withAnthropicStructuredOutputDefault } from '../../llm/provider-registry';
import { getAgentTaskRouterMode } from '../../db/repos/settings-repo';
import { createRunStepTracker } from './budget';
import { agentToolContext } from '../tools/tool-context';
import { compileToolSet, synthesizeFinishTool, FINISH_TOOL_NAME } from '../tools/compile';

// 下沉到 errors.ts（叶子模块）以打破与 provider-registry 的循环依赖；此处 re-export 兼容既有调用方。
export { AgentCancelled } from './errors';
import { AgentCancelled } from './errors';

export interface AgentRunResult {
  runId: string;
  output: unknown;
  tokensUsed: number;
  stepCount: number;
  /** 本次 run 命中缓存的输入 token（遥测用；DeepSeek/OpenAI/Anthropic 各自字段，见 readCacheHitTokens） */
  cacheHitTokens: number;
}

export async function runAgentLoop(opts: {
  skill: SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  const { skill, ctx, input } = opts;
  const runId = randomUUID();
  const label = inputLabel(input); // 哪页/哪块，贯穿本 run 的所有事件，便于排查

  ctx.emit('agent:run-started', `${skill.name} started${label ? `: ${label}` : ''}`, {
    runId,
    parentRunId: ctx.parentRunId,
    skillId: skill.id,
    label,
    subjectId: ctx.subject.id,
  });

  const startedAt = Date.now();
  const runSteps = createRunStepTracker(ctx.budgetSnapshot.maxSteps);

  const { model, route } = resolveSkillModel(skill);
  const toolDefs = ctx.toolRegistry.resolve(skill.tools);
  const toolCtx = agentToolContext(ctx);
  const toolSet = compileToolSet(toolDefs, toolCtx, {
    chargeStep: () => runSteps.chargeStep(),
    onToolCall: (info) => ctx.emit('agent:step', `${skill.name} called ${info.tool}`, {
      runId,
      parentRunId: ctx.parentRunId,
      skillId: skill.id,
      stepIndex: runSteps.stepCount,
      kind: 'tool-call',
      tool: info.tool,
      input: info.input,
      outputPreview: info.output !== undefined ? previewOutput(info.output) : undefined,
      error: info.error,
      durationMs: info.durationMs,
    }),
  });
  const messages = buildMessages(skill, input);

  // LLM 调用前的取消闸门
  if (ctx.cancelled()) throw new AgentCancelled();
  ctx.budget.assertWithin();

  const hasTools = skill.tools.length > 0;
  let generation: GenerationResult;
  try {
    generation =
      skill.outputSchema && hasTools
        ? await generateCombinedResult(skill, ctx, runId, model, route, messages, toolSet, skill.outputSchema)
        : skill.outputSchema
          ? await generateStructuredResult(skill, ctx, runId, runSteps, model, route, messages)
          : await generateTextResult(skill, ctx, runId, model, route, messages, toolSet);
  } catch (err) {
    // 结构化输出失败（解析失败 / 不符合 schema，恢复也补不了）：emit 富诊断（原始输出 + 问题路径），
    // 让"哪页/哪块、模型吐了什么、哪个字段错"在 job_events 与 UI 直接可见，再原样上抛。
    ctx.emit('agent:error', `${skill.name} generation failed${label ? ` for ${label}` : ''}`, {
      runId,
      parentRunId: ctx.parentRunId,
      skillId: skill.id,
      label,
      ...summarizeGenerationError(err),
    });
    throw err;
  }
  const { output, inputTokens, outputTokens, cacheHitTokens } = generation;

  runSteps.chargeStep(); // final 输出本身计 1 步
  // 事后登记：token 超限由下一个 run 开始时的 assertWithin 拦截
  //（结合 ingest 预检 fail-fast，事后防线足够）。
  ctx.budget.chargeTokens(inputTokens + outputTokens);

  ctx.emit('agent:step', `${skill.name} produced final output${label ? `: ${label}` : ''}`, {
    runId,
    parentRunId: ctx.parentRunId,
    skillId: skill.id,
    label,
    stepIndex: runSteps.stepCount,
    kind: 'final',
    tokensIn: inputTokens,
    tokensOut: outputTokens,
    cacheHitTokens,
  });

  ctx.emit('agent:run-completed', `${skill.name} completed${label ? `: ${label}` : ''}`, {
    runId,
    label,
    tokensUsed: inputTokens + outputTokens,
    cacheHitTokens,
    stepCount: runSteps.stepCount,
    durationMs: Date.now() - startedAt,
  });

  return {
    runId,
    output,
    tokensUsed: inputTokens + outputTokens,
    stepCount: runSteps.stepCount,
    cacheHitTokens,
  };
}

type TaskRoute = ReturnType<typeof resolveTask>;
type ResolvedModel = ReturnType<typeof resolveModel>;
type RunStepTracker = ReturnType<typeof createRunStepTracker>;

interface GenerationResult {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
}

/**
 * skill id → LLM 路由 task key：把 `<pipeline>-<stage>` 形式 id 的**首个**连字符换成冒号，
 * 得到 `<pipeline>:<stage>`（`ingest-planner` → `ingest:planner`、
 * `ingest-verifier-triage` → `ingest:verifier-triage`）。无连字符的 id 原样返回。
 * 冒号只存在于路由 key——id/文件名仍用连字符（文件名不能含冒号）。
 */
export function skillTaskKey(id: string): string {
  return id.replace('-', ':');
}

/** 解析 LLM 模型：task-router defaults < tasks['<pipeline>:<stage>'] < frontmatter（视 mode 而定）。 */
function resolveSkillModel(skill: SkillTemplate): { model: ResolvedModel; route: TaskRoute } {
  const taskKey = skillTaskKey(skill.id);
  const routerMode = getAgentTaskRouterMode();
  const route = resolveTask(taskKey, routerMode === 'frontmatter-override' ? skill.model : undefined);
  return { model: resolveModel(route), route };
}

/** 构造 system + user 消息（非字符串 input 序列化为 JSON）。 */
function buildMessages(skill: SkillTemplate, input: unknown): ModelMessage[] {
  return [
    { role: 'system', content: skill.systemPrompt },
    { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
  ];
}

/** 结构化输出路径：generateObject，失败时尝试从 err.text 恢复。 */
async function generateStructuredResult(
  skill: SkillTemplate,
  ctx: AgentContext,
  runId: string,
  runSteps: RunStepTracker,
  model: ResolvedModel,
  route: TaskRoute,
  messages: ModelMessage[],
): Promise<GenerationResult> {
  const schema = skill.outputSchema!;
  try {
    const result = await generateObject({
      model,
      schema,
      messages,
      maxOutputTokens: skill.model?.maxTokens ?? route.maxTokens,
      temperature: skill.model?.temperature ?? route.temperature,
      providerOptions: withAnthropicStructuredOutputDefault(route),
    });
    return {
      output: result.object,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheHitTokens: readCacheHitTokens(result.providerMetadata),
    };
  } catch (err) {
    const recovered = recoverStructuredOutput(err, schema);
    if (!recovered) throw err;

    ctx.emit('agent:step', `${skill.name} recovered structured output`, {
      runId,
      parentRunId: ctx.parentRunId,
      skillId: skill.id,
      stepIndex: runSteps.stepCount,
      kind: 'structured-output-recovery',
      reason: recovered.reason,
    });
    return {
      output: recovered.object,
      inputTokens: recovered.inputTokens,
      outputTokens: recovered.outputTokens,
      cacheHitTokens: 0, // 恢复路径（解析失败）不追踪缓存命中
    };
  }
}

/** 自由文本路径：generateText + 工具调用循环。 */
async function generateTextResult(
  skill: SkillTemplate,
  ctx: AgentContext,
  runId: string,
  model: ResolvedModel,
  route: TaskRoute,
  messages: ModelMessage[],
  toolSet: ToolSet,
): Promise<GenerationResult> {
  const result = await generateText({
    model,
    tools: toolSet,
    messages,
    maxOutputTokens: skill.model?.maxTokens ?? route.maxTokens,
    temperature: skill.model?.temperature ?? route.temperature,
    // SDK maxSteps 是第一道防线（静默截断工具轮次）；runSteps 是纵深防御——
    // generateObject 路径的唯一步数防线，也是全路径的步数遥测来源。
    // 两者同值是有意的，不要为让 runSteps 先触发而改成 N-1。
    stopWhen: stepCountIs(ctx.budgetSnapshot.maxSteps),
    // 工具调用参数修复：部分供应商（如 DeepSeek）会在合法 JSON 参数后多吐尾随字符
    //（典型多一个 `}`），AI SDK 严格 JSON.parse 拒绝 → InvalidToolInputError。
    // 提取第一个配平 JSON 值剥离尾随垃圾后重试；仅修参数解析错误，schema 不匹配不误修。
    experimental_repairToolCall: async ({ toolCall, error }) => {
      if (!InvalidToolInputError.isInstance(error)) return null;
      const repaired = repairToolCallArgs(toolCall.input);
      if (!repaired) return null;
      ctx.emit('agent:step', `${skill.name} repaired tool-call args for ${toolCall.toolName}`, {
        runId,
        parentRunId: ctx.parentRunId,
        skillId: skill.id,
        kind: 'tool-call-repair',
        tool: toolCall.toolName,
      });
      return { ...toolCall, input: repaired };
    },
  });
  return {
    output: result.text,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cacheHitTokens: readCacheHitTokens(result.providerMetadata),
  };
}

/** 组合路径下「未产出可用结构化结果」的可重试信号：模型既没调 finish，文本也无法恢复。 */
class NoFinishOutputError extends Error {}

/**
 * 「finish 工具入参校验失败」判定：模型偶发以空/不合规入参调 finish（典型 packyapi+Claude：
 * extended thinking 后函数调用参数串为空 → AI SDK 以 {} 校验 schema → InvalidToolInputError）。
 * 这类抖动靠重试恢复，而非补字段；普通工具（wiki.read/search）的入参错误不在此列。
 */
function isFinishArgsError(err: unknown): boolean {
  return InvalidToolInputError.isInstance(err)
    && (err as { toolName?: unknown }).toolName === FINISH_TOOL_NAME;
}

/**
 * 组合路径：工具调用循环 + 合成 finish 工具产出结构化结果。
 * 适用于 skill.outputSchema 非空且 skill.tools 非空时（如 ingest-planner / ingest-writer）。
 * 末步强制 finish（experimental_prepareStep），杜绝"只读不交"。
 *
 * 重试：模型偶发以空入参调 finish（packyapi+Claude 间歇抖动，参数串为空 → schema 校验失败），
 * 或干脆不调 finish 且文本不可恢复。这类失败是单页级偶发的（同 job 多数页正常产出），
 * 故做有界重试再行上抛，避免单页抖动让整个 ingest job 硬失败。
 */
async function generateCombinedResult(
  skill: SkillTemplate,
  ctx: AgentContext,
  runId: string,
  model: ResolvedModel,
  route: TaskRoute,
  messages: ModelMessage[],
  toolSet: ToolSet,
  schema: ZodSchema,
): Promise<GenerationResult> {
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await runCombinedAttempt(skill, ctx, model, route, messages, toolSet, schema);
    } catch (err) {
      lastError = err;
      const retryable = isFinishArgsError(err) || err instanceof NoFinishOutputError;
      if (attempt >= MAX_ATTEMPTS || !retryable) throw err;
      ctx.emit('agent:step', `${skill.name} retrying structured output (attempt ${attempt}/${MAX_ATTEMPTS - 1})`, {
        runId,
        parentRunId: ctx.parentRunId,
        skillId: skill.id,
        kind: 'finish-retry',
        attempt,
        reason: isFinishArgsError(err) ? 'invalid-finish-args' : 'no-finish-output',
      });
    }
  }
  // 不可达：最后一次 attempt 必 return 或 throw；保留以满足类型完整性。
  throw lastError ?? new Error(`${skill.name} combined generation failed`);
}

/** 组合路径单次尝试：一次 generateText，命中 finish 即捕获结构化结果；否则尝试从文本恢复。 */
async function runCombinedAttempt(
  skill: SkillTemplate,
  ctx: AgentContext,
  model: ResolvedModel,
  route: TaskRoute,
  messages: ModelMessage[],
  toolSet: ToolSet,
  schema: ZodSchema,
): Promise<GenerationResult> {
  let captured: unknown;
  const finishSet = synthesizeFinishTool(schema, (v) => { captured = v; });
  const tools = { ...toolSet, ...finishSet };
  const result = await generateText({
    model,
    tools,
    messages,
    maxOutputTokens: skill.model?.maxTokens ?? route.maxTokens,
    temperature: skill.model?.temperature ?? route.temperature,
    stopWhen: stepCountIs(ctx.budgetSnapshot.maxSteps),
    // 末步只留 finish 工具，杜绝"只读不交"：到达倒数第二步且尚未 finish 时用 activeTools
    // 收窄工具集（不用 tool_choice 强制——Claude Code 系中转会整单拒绝强制自定义工具；
    // 模型若仍以纯文本作答，由下方 recoverStructuredOutput 兜底）。
    prepareStep: async ({ stepNumber }) =>
      stepNumber >= ctx.budgetSnapshot.maxSteps - 1 && captured === undefined
        ? { activeTools: [FINISH_TOOL_NAME] }
        : {},
    experimental_repairToolCall: async ({ toolCall, error }) => {
      if (!InvalidToolInputError.isInstance(error)) return null;
      const repaired = repairToolCallArgs(toolCall.input);
      return repaired ? { ...toolCall, input: repaired } : null;
    },
  });
  if (captured === undefined) {
    // 兜底：模型把结构化结果写进了文本而非 finish 调用——尝试从 result.text 恢复。
    const recovered = recoverStructuredOutput({ text: result.text }, schema);
    if (!recovered) throw new NoFinishOutputError(`${skill.name} did not call finish and text is not valid structured output`);
    captured = recovered.object;
  }
  return {
    output: captured,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cacheHitTokens: readCacheHitTokens(result.providerMetadata),
  };
}

function previewOutput(out: unknown): string {
  try {
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  } catch { return '<unserializable>'; }
}

function recoverStructuredOutput(err: unknown, schema: ZodSchema): {
  object: unknown;
  inputTokens: number;
  outputTokens: number;
  reason: string;
} | null {
  // AI SDK 4 `NoObjectGeneratedError` carries the raw model output on `err.text`.
  const rawText = readStringProperty(err, 'text');
  if (!rawText) return null;

  const parsed = parseJsonValue(rawText);
  if (parsed === undefined) return null;

  const direct = schema.safeParse(parsed);
  if (direct.success) {
    return {
      object: direct.data,
      inputTokens: readUsageToken(err, 'inputTokens'),
      outputTokens: readUsageToken(err, 'outputTokens'),
      reason: 'recovered JSON from err.text matched schema',
    };
  }

  const repaired = repairJsonStringContainers(parsed, schema);
  if (repaired === undefined) return null;

  return {
    object: repaired,
    inputTokens: readUsageToken(err, 'inputTokens'),
    outputTokens: readUsageToken(err, 'outputTokens'),
    reason: 'parsed JSON-string object fields from err.text',
  };
}

function repairJsonStringContainers(value: unknown, schema: ZodSchema): unknown | undefined {
  let current = cloneJson(value);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = schema.safeParse(current);
    if (result.success) return result.data;

    let changed = false;
    for (const issue of result.error.issues) {
      const expected = 'expected' in issue ? issue.expected : undefined;
      const received = 'received' in issue ? issue.received : undefined;
      if ((expected !== 'object' && expected !== 'array') || received !== 'string') continue;

      const text = getAtPath(current, issue.path);
      if (typeof text !== 'string') continue;

      const parsed = parseJsonValue(text);
      if (!matchesExpectedContainer(parsed, expected)) continue;

      current = setAtPath(current, issue.path, parsed);
      changed = true;
    }

    if (!changed) return undefined;
  }

  const final = schema.safeParse(current);
  return final.success ? final.data : undefined;
}

function parseJsonValue(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    const extracted = extractFirstJsonValue(text);
    if (!extracted) return undefined;
    try { return JSON.parse(extracted); } catch { return undefined; }
  }
}

function extractFirstJsonValue(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;

  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * 修复工具调用参数：部分供应商在合法 JSON 参数前后多吐字符（典型：DeepSeek 在结尾多一个
 * `}`）。提取第一个配平的 JSON 值（剥离前导/尾随垃圾）并确认其可解析；得不到与原文不同的
 * 合法 JSON 时返回 null（已是干净 JSON 的 schema 级错误不会被误修，也避免无意义重试）。
 */
export function repairToolCallArgs(rawArgs: string): string | null {
  const extracted = extractFirstJsonValue(rawArgs);
  if (!extracted || extracted === rawArgs) return null;
  try {
    JSON.parse(extracted);
  } catch {
    return null;
  }
  return extracted;
}

function matchesExpectedContainer(value: unknown, expected: unknown): boolean {
  if (expected === 'array') return Array.isArray(value);
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getAtPath(value: unknown, path: Array<string | number>): unknown {
  return path.reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string | number, unknown>)[key];
  }, value);
}

function setAtPath(value: unknown, path: Array<string | number>, next: unknown): unknown {
  if (path.length === 0) return next;

  const root = cloneJson(value);
  let cursor = root as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const child = cursor[key];
    if (child === null || typeof child !== 'object') return value;
    cursor = child as Record<string | number, unknown>;
  }
  cursor[path[path.length - 1]] = next;
  return root;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const direct = (value as Record<string, unknown>)[key];
  if (typeof direct === 'string') return direct;
  return undefined;
}

/** 从 agent 输入提取一个简短 item 标识（写页 slug / 块 id 等），用于日志区分是哪块/哪页。 */
export function inputLabel(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ['slug', 'path', 'id', 'key', 'title']) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export interface GenerationErrorSummary {
  finishReason?: string;
  /** 模型原始输出（截断），用于排查"产了什么导致不符合 schema"。 */
  rawText?: string;
  /** schema 校验问题（zod issue 路径）或解析错误信息。 */
  detail?: string;
}

/** 把 AI SDK 的 NoObjectGeneratedError 等结构化输出错误提炼成可读诊断（供日志/事件）。 */
export function summarizeGenerationError(err: unknown): GenerationErrorSummary {
  if (!err || typeof err !== 'object') return {};
  const e = err as Record<string, unknown>;
  const out: GenerationErrorSummary = {};
  if (typeof e.finishReason === 'string') out.finishReason = e.finishReason;
  if (typeof e.text === 'string') out.rawText = e.text.length > 800 ? e.text.slice(0, 800) + '…' : e.text;
  const issues = readZodIssues(e);
  if (issues) out.detail = issues;
  else {
    const cause = e.cause as Record<string, unknown> | undefined;
    if (cause && typeof cause.message === 'string') out.detail = cause.message;
    else if (typeof e.message === 'string') out.detail = e.message;
  }
  return out;
}

/** 从 TypeValidationError（err.cause）内层 ZodError（.cause.issues 或 .issues）提取问题路径。 */
function readZodIssues(e: Record<string, unknown>): string | undefined {
  const c1 = e.cause as Record<string, unknown> | undefined;
  const c2 = c1?.cause as Record<string, unknown> | undefined;
  const raw = c2?.issues ?? c1?.issues;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw
    .slice(0, 5)
    .map((i) => {
      const issue = i as Record<string, unknown>;
      const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
      return `${path || '(root)'}: ${String(issue.message ?? 'invalid')}`;
    })
    .join('; ');
}

/**
 * 从 provider metadata 提取本次调用「命中缓存的输入 token」数（各供应商命名不同）：
 * DeepSeek `deepseek.promptCacheHitTokens` / OpenAI `openai.cachedPromptTokens` /
 * Anthropic `anthropic.cacheReadInputTokens`。无则 0。仅用于遥测，让缓存收益在页面可见。
 */
export function readCacheHitTokens(meta: unknown): number {
  if (!meta || typeof meta !== 'object') return 0;
  const m = meta as Record<string, unknown>;
  const candidates: Array<[string, string]> = [
    ['deepseek', 'promptCacheHitTokens'],
    ['openai', 'cachedPromptTokens'],
    ['anthropic', 'cacheReadInputTokens'],
  ];
  for (const [provider, field] of candidates) {
    const p = m[provider];
    if (p && typeof p === 'object') {
      const v = (p as Record<string, unknown>)[field];
      if (typeof v === 'number' && v >= 0) return v;
    }
  }
  return 0;
}

function readUsageToken(value: unknown, key: 'inputTokens' | 'outputTokens'): number {
  if (!value || typeof value !== 'object') return 0;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') return 0;
  const token = (usage as Record<string, unknown>)[key];
  return typeof token === 'number' ? token : 0;
}
