import { generateObject, generateText, tool, InvalidToolArgumentsError, type ToolSet, type CoreMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import type { ZodSchema } from 'zod';
import type { AgentContext, SkillTemplate } from '../types';
import { resolveTask } from '../../llm/task-router';
import { resolveModel } from '../../llm/provider-registry';
import { getAgentTaskRouterMode } from '../../db/repos/settings-repo';
import { createRunStepTracker } from './budget';
import { agentToolContext } from '../tools/tool-context';

export class AgentCancelled extends Error {
  constructor() { super('Agent cancelled'); this.name = 'AgentCancelled'; }
}

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
  const toolSet = compileToolSet(skill, ctx, runId, runSteps);
  const messages = buildMessages(skill, input);

  // LLM 调用前的取消闸门
  if (ctx.cancelled()) throw new AgentCancelled();
  ctx.budget.assertWithin();

  let generation: GenerationResult;
  try {
    generation = skill.outputSchema
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

/** 解析 LLM 模型：task-router defaults < tasks['skill:<id>'] < frontmatter（视 mode 而定）。 */
function resolveSkillModel(skill: SkillTemplate): { model: ResolvedModel; route: TaskRoute } {
  const taskKey = `skill:${skill.id}`;
  const routerMode = getAgentTaskRouterMode();
  const route = resolveTask(taskKey, routerMode === 'frontmatter-override' ? skill.model : undefined);
  return { model: resolveModel(route), route };
}

/** 把 skill 声明的内部工具编译为 provider 可用的 ToolSet（带步数计费与 emit 遥测）。 */
function compileToolSet(
  skill: SkillTemplate,
  ctx: AgentContext,
  runId: string,
  runSteps: RunStepTracker,
): ToolSet {
  const toolDefs = ctx.toolRegistry.resolve(skill.tools);
  const toolCtx = agentToolContext(ctx);
  const toolSet: ToolSet = {};
  const usedToolNames = new Set<string>();
  for (const t of toolDefs) {
    // 内部工具名用点号分命名空间（如 `wiki.read`），
    // 但 provider API 要求 ^[a-zA-Z0-9_-]{1,64}$ —— 在边界处转换。
    const providerName = toProviderToolName(t.name, usedToolNames);
    usedToolNames.add(providerName);
    toolSet[providerName] = tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: async (args: unknown) => {
        const stepStart = Date.now();
        runSteps.chargeStep();
        try {
          const out = await t.handler(args, toolCtx);
          ctx.emit('agent:step', `${skill.name} called ${t.name}`, {
            runId,
            parentRunId: ctx.parentRunId,
            skillId: skill.id,
            stepIndex: runSteps.stepCount,
            kind: 'tool-call',
            tool: t.name,
            input: args,
            outputPreview: previewOutput(out),
            durationMs: Date.now() - stepStart,
          });
          return out;
        } catch (err) {
          ctx.emit('agent:step', `${skill.name} tool ${t.name} failed`, {
            runId,
            parentRunId: ctx.parentRunId,
            skillId: skill.id,
            stepIndex: runSteps.stepCount,
            kind: 'tool-call',
            tool: t.name,
            input: args,
            error: (err as Error).message,
            durationMs: Date.now() - stepStart,
          });
          throw err;
        }
      },
    });
  }
  return toolSet;
}

/** 构造 system + user 消息（非字符串 input 序列化为 JSON）。 */
function buildMessages(skill: SkillTemplate, input: unknown): CoreMessage[] {
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
  messages: CoreMessage[],
): Promise<GenerationResult> {
  const schema = skill.outputSchema!;
  try {
    const result = await generateObject({
      model,
      schema,
      messages,
      maxTokens: skill.model?.maxTokens ?? route.maxTokens,
      temperature: skill.model?.temperature ?? route.temperature,
    });
    return {
      output: result.object,
      inputTokens: result.usage?.promptTokens ?? 0,
      outputTokens: result.usage?.completionTokens ?? 0,
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
  messages: CoreMessage[],
  toolSet: ToolSet,
): Promise<GenerationResult> {
  const result = await generateText({
    model,
    tools: toolSet,
    messages,
    maxTokens: skill.model?.maxTokens ?? route.maxTokens,
    temperature: skill.model?.temperature ?? route.temperature,
    // SDK maxSteps 是第一道防线（静默截断工具轮次）；runSteps 是纵深防御——
    // generateObject 路径的唯一步数防线，也是全路径的步数遥测来源。
    // 两者同值是有意的，不要为让 runSteps 先触发而改成 N-1。
    maxSteps: ctx.budgetSnapshot.maxSteps,
    // 工具调用参数修复：部分供应商（如 DeepSeek）会在合法 JSON 参数后多吐尾随字符
    //（典型多一个 `}`），AI SDK 严格 JSON.parse 拒绝 → InvalidToolArgumentsError。
    // 提取第一个配平 JSON 值剥离尾随垃圾后重试；仅修参数解析错误，schema 不匹配不误修。
    experimental_repairToolCall: async ({ toolCall, error }) => {
      if (!InvalidToolArgumentsError.isInstance(error)) return null;
      const repaired = repairToolCallArgs(toolCall.args);
      if (!repaired) return null;
      ctx.emit('agent:step', `${skill.name} repaired tool-call args for ${toolCall.toolName}`, {
        runId,
        parentRunId: ctx.parentRunId,
        skillId: skill.id,
        kind: 'tool-call-repair',
        tool: toolCall.toolName,
      });
      return { ...toolCall, args: repaired };
    },
  });
  return {
    output: result.text,
    inputTokens: result.usage?.promptTokens ?? 0,
    outputTokens: result.usage?.completionTokens ?? 0,
    cacheHitTokens: readCacheHitTokens(result.providerMetadata),
  };
}

/**
 * Map an internal tool name to a provider-safe function name.
 *
 * Provider APIs (OpenAI / DeepSeek / xAI / Mistral / …) require tool names to
 * match `^[a-zA-Z0-9_-]{1,64}$`. Our internal names use dots for namespacing
 * (`vault.read`, `dispatch.skill`), so any non-conforming
 * character becomes `_`, the result is capped at 64 chars, and collisions are
 * disambiguated with a numeric suffix.
 */
function toProviderToolName(name: string, used: Set<string>): string {
  let base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (base.length === 0) base = 'tool';

  if (!used.has(base)) return base;

  for (let i = 2; ; i += 1) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
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
      inputTokens: readUsageToken(err, 'promptTokens'),
      outputTokens: readUsageToken(err, 'completionTokens'),
      reason: 'recovered JSON from err.text matched schema',
    };
  }

  const repaired = repairJsonStringContainers(parsed, schema);
  if (repaired === undefined) return null;

  return {
    object: repaired,
    inputTokens: readUsageToken(err, 'promptTokens'),
    outputTokens: readUsageToken(err, 'completionTokens'),
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

function readUsageToken(value: unknown, key: 'promptTokens' | 'completionTokens'): number {
  if (!value || typeof value !== 'object') return 0;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') return 0;
  const token = (usage as Record<string, unknown>)[key];
  return typeof token === 'number' ? token : 0;
}
