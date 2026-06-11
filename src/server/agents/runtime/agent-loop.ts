import { generateObject, generateText, tool, type ToolSet, type CoreMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import type { ZodSchema } from 'zod';
import type { AgentContext, SkillTemplate } from '../types';
import { resolveTask } from '../../llm/task-router';
import { resolveModel } from '../../llm/provider-registry';
import { getAgentTaskRouterMode } from '../../db/repos/settings-repo';
import { createRunStepTracker } from './budget';

export class AgentCancelled extends Error {
  constructor() { super('Agent cancelled'); this.name = 'AgentCancelled'; }
}

export interface AgentRunResult {
  runId: string;
  output: unknown;
  tokensUsed: number;
  stepCount: number;
}

export async function runAgentLoop(opts: {
  skill: SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  const { skill, ctx, input } = opts;
  const runId = randomUUID();

  ctx.emit('agent:run-started', `${skill.name} started`, {
    runId,
    parentRunId: ctx.parentRunId,
    skillId: skill.id,
    subjectId: ctx.subject.id,
  });

  const startedAt = Date.now();
  const runSteps = createRunStepTracker(ctx.budgetSnapshot.maxSteps);

  // Resolve LLM model: task-router defaults < tasks['skill:<id>'] < frontmatter (if mode allows).
  const taskKey = `skill:${skill.id}`;
  const routerMode = getAgentTaskRouterMode();
  const route = resolveTask(taskKey, routerMode === 'frontmatter-override' ? skill.model : undefined);
  const model = resolveModel(route);

  // Resolve tools.
  const toolDefs = ctx.toolRegistry.resolve(skill.tools);
  const toolSet: ToolSet = {};
  const usedToolNames = new Set<string>();
  for (const t of toolDefs) {
    // Internal tool names are dot-namespaced (`vault.read`, `mcp.<server>.<tool>`),
    // but provider APIs require ^[a-zA-Z0-9_-]{1,64}$ — translate at the boundary.
    const providerName = toProviderToolName(t.name, usedToolNames);
    usedToolNames.add(providerName);
    toolSet[providerName] = tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: async (args: unknown) => {
        const stepStart = Date.now();
        runSteps.chargeStep();
        try {
          const out = await t.handler(args, ctx);
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

  // Build messages.
  const messages: CoreMessage[] = [
    { role: 'system', content: skill.systemPrompt },
    { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
  ];

  // Cancellation gate before LLM call.
  if (ctx.cancelled()) throw new AgentCancelled();
  ctx.budget.assertWithin();

  let output: unknown;
  let inputTokens = 0;
  let outputTokens = 0;

  if (skill.outputSchema) {
    try {
      const result = await generateObject({
        model,
        schema: skill.outputSchema,
        messages,
        maxTokens: skill.model?.maxTokens ?? route.maxTokens,
        temperature: skill.model?.temperature ?? route.temperature,
      });
      output = result.object;
      inputTokens = result.usage?.promptTokens ?? 0;
      outputTokens = result.usage?.completionTokens ?? 0;
    } catch (err) {
      const recovered = recoverStructuredOutput(err, skill.outputSchema);
      if (!recovered) throw err;

      output = recovered.object;
      inputTokens = recovered.inputTokens;
      outputTokens = recovered.outputTokens;
      ctx.emit('agent:step', `${skill.name} recovered structured output`, {
        runId,
        parentRunId: ctx.parentRunId,
        skillId: skill.id,
        stepIndex: runSteps.stepCount,
        kind: 'structured-output-recovery',
        reason: recovered.reason,
      });
    }
  } else {
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
    });
    output = result.text;
    inputTokens = result.usage?.promptTokens ?? 0;
    outputTokens = result.usage?.completionTokens ?? 0;
  }

  runSteps.chargeStep(); // final 输出本身计 1 步
  // 事后登记：token 超限由下一个 run 开始时的 assertWithin 拦截
  //（结合 ingest 预检 fail-fast，事后防线足够）。
  ctx.budget.chargeTokens(inputTokens + outputTokens);

  ctx.emit('agent:step', `${skill.name} produced final output`, {
    runId,
    parentRunId: ctx.parentRunId,
    skillId: skill.id,
    stepIndex: runSteps.stepCount,
    kind: 'final',
    tokensIn: inputTokens,
    tokensOut: outputTokens,
  });

  ctx.emit('agent:run-completed', `${skill.name} completed`, {
    runId,
    tokensUsed: inputTokens + outputTokens,
    stepCount: runSteps.stepCount,
    durationMs: Date.now() - startedAt,
  });

  return {
    runId,
    output,
    tokensUsed: inputTokens + outputTokens,
    stepCount: runSteps.stepCount,
  };
}

/**
 * Map an internal tool name to a provider-safe function name.
 *
 * Provider APIs (OpenAI / DeepSeek / xAI / Mistral / …) require tool names to
 * match `^[a-zA-Z0-9_-]{1,64}$`. Our internal names use dots for namespacing
 * (`vault.read`, `dispatch.skill`, `mcp.<server>.<tool>`), so any non-conforming
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

function readUsageToken(value: unknown, key: 'promptTokens' | 'completionTokens'): number {
  if (!value || typeof value !== 'object') return 0;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') return 0;
  const token = (usage as Record<string, unknown>)[key];
  return typeof token === 'number' ? token : 0;
}
