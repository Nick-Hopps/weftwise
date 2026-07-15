import {
  embedMany,
  generateObject,
  generateText,
  NoObjectGeneratedError,
  stepCountIs,
  streamText,
} from 'ai';
import type { ModelMessage, Tool, LanguageModel } from 'ai';
import type { ZodType } from 'zod';
import type { LLMRouteOverride, LLMTask, ResolvedTaskRoute } from './config-schema';
import { getLLMConfig } from './config-loader';
import { getEmbeddingModel, getLanguageModel } from './provider-factory';
import { resolveTask } from './task-router';
import { LLMConfigError } from './errors';
import { AgentCancelled } from '../agents/runtime/errors';
import { recordUsage } from '../db/repos/usage-repo';
import { summarizeGenerationError } from './generation-error';

/** shouldCancel 轮询间隔（ms）——固定 2s，兼顾及时性与开销。 */
const CANCEL_POLL_INTERVAL_MS = 2000;

/**
 * 记一次调用用量（best-effort 双保险：repo 内部已 try/catch，这里再兜一层
 * 保证 mock/异常场景下也绝不影响 LLM 调用返回）。usage 缺失守卫在 repo 层。
 */
function recordCallUsage(
  route: { task: string; model: string },
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): void {
  try {
    recordUsage({
      task: route.task,
      model: route.model,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
  } catch (err) {
    console.warn('[usage] record failed (ignored)', err);
  }
}

/**
 * 若传入 shouldCancel，则以固定间隔轮询该函数；一旦返回 true 就 abort 传入的
 * controller，供调用方据 aborted 标记决定是否需要抛 AgentCancelled。
 * 未传 shouldCancel 时不创建定时器，行为与改动前完全一致。
 * 返回的 cleanup 必须在所有退出路径（正常完成/异常/取消）调用，定时器已 unref。
 */
function startCancelPolling(
  shouldCancel: (() => boolean) | undefined,
  controller: AbortController,
): { cleanup: () => void; cancelledRef: { current: boolean } } {
  const cancelledRef = { current: false };
  if (!shouldCancel) return { cleanup: () => {}, cancelledRef };
  const timer = setInterval(() => {
    if (shouldCancel()) {
      cancelledRef.current = true;
      controller.abort();
    }
  }, CANCEL_POLL_INTERVAL_MS);
  timer.unref?.();
  return { cleanup: () => clearInterval(timer), cancelledRef };
}

export function resolveModel(route: ResolvedTaskRoute): LanguageModel {
  return getLanguageModel(route);
}

/**
 * anthropic 结构化输出默认走 `structuredOutputMode: 'auto'`（支持时用原生 output_format）。
 * SDK 默认的 jsonTool 模式会以 tool_choice 强制自定义 'json' 工具，被 Claude Code 系中转
 *（code.taluna.ai 等）整单拒绝；llm-config 里显式配置的 providerOptions 优先于此默认。
 */
export function withAnthropicStructuredOutputDefault(
  route: ResolvedTaskRoute,
): ResolvedTaskRoute['providerOptions'] {
  if (route.provider.provider !== 'anthropic') return route.providerOptions;
  const anthropic = route.providerOptions?.anthropic ?? {};
  if (anthropic.structuredOutputMode !== undefined) return route.providerOptions;
  return {
    ...route.providerOptions,
    anthropic: { ...anthropic, structuredOutputMode: 'auto' },
  };
}

export interface StructuredOutputOptions {
  /** 仅在 JSON 解析或 schema 校验失败时重试；上限 2 次。 */
  schemaRetries?: number;
}

function schemaRetrySystemPrompt(systemPrompt: string, detail: string | undefined): string {
  return `${systemPrompt}

=== STRUCTURED OUTPUT RETRY ===
The previous response could not be validated against the required JSON schema${detail ? `: ${detail}` : '.'}
Generate the complete result again. Preserve factual accuracy, include every required field, and return only data matching the schema.`;
}

/**
 * Generate a structured JSON object validated against a Zod schema.
 *
 * The model is selected by resolving the task route:
 *   defaults < task config < call-site overrides
 */
export async function generateStructuredOutput<T>(
  task: LLMTask,
  schema: ZodType<T>,
  systemPrompt: string,
  userPrompt: string,
  overrides: LLMRouteOverride = {},
  options: StructuredOutputOptions = {},
): Promise<T> {
  const route = resolveTask(task, overrides);
  const prefix = `[LLM][Task: ${route.task}][Model: ${route.logLabel}]`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.error(`${prefix} abort: timeout reached after ${route.timeoutMs}ms`);
    controller.abort();
  }, route.timeoutMs);

  const t0 = Date.now();
  console.log(`${prefix} generateObject started`);

  try {
    const schemaRetries = Math.min(2, Math.max(0, Math.trunc(options.schemaRetries ?? 0)));
    let currentSystemPrompt = systemPrompt;

    for (let attempt = 0; attempt <= schemaRetries; attempt += 1) {
      try {
        const result = await generateObject({
          model: getLanguageModel(route),
          schema,
          system: currentSystemPrompt,
          prompt: userPrompt,
          maxOutputTokens: route.maxTokens,
          temperature: route.temperature,
          topP: route.topP,
          topK: route.topK,
          presencePenalty: route.presencePenalty,
          frequencyPenalty: route.frequencyPenalty,
          seed: route.seed,
          maxRetries: route.maxRetries,
          headers: route.headers,
          providerOptions: withAnthropicStructuredOutputDefault(route),
          abortSignal: controller.signal,
        });

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `${prefix} done in ${elapsed}s | tokens: in=${result.usage?.inputTokens ?? 'n/a'} out=${result.usage?.outputTokens ?? 'n/a'}`,
        );
        recordCallUsage(route, result.usage);
        return result.object;
      } catch (err) {
        if (attempt >= schemaRetries || !NoObjectGeneratedError.isInstance(err)) throw err;

        const summary = summarizeGenerationError(err, { includeRawText: false });
        console.warn(
          `${prefix} structured output invalid; retrying (${attempt + 1}/${schemaRetries})`,
          summary,
        );
        currentSystemPrompt = schemaRetrySystemPrompt(systemPrompt, summary.detail);
      }
    }

    throw new Error('Structured output retry loop exhausted unexpectedly');
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const details: Record<string, unknown> = { elapsed };
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      if (e.usage) details.usage = e.usage;
      if (e.finishReason) details.finishReason = e.finishReason;
      if (e.cause) {
        details.cause =
          e.cause instanceof Error ? e.cause.message : String(e.cause);
      }
    }
    console.error(
      `${prefix} failed after ${elapsed}s:`,
      err instanceof Error ? err.message : err,
      details,
    );
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Stream a plain text response from the LLM for the given task route.
 */
export function streamTextResponse(
  task: LLMTask,
  systemPrompt: string,
  userPrompt: string,
  abortSignal?: AbortSignal,
  overrides: LLMRouteOverride = {},
): ReturnType<typeof streamText> {
  const route = resolveTask(task, overrides);
  const prefix = `[LLM][Task: ${route.task}][Model: ${route.logLabel}]`;
  console.log(`${prefix} streamText started`);

  // Merge caller abort signal with route timeout
  const timeoutSignal = AbortSignal.timeout(route.timeoutMs);
  let mergedSignal: AbortSignal;
  if (abortSignal) {
    mergedSignal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([abortSignal, timeoutSignal])
        : abortSignal; // fallback: prefer caller signal on older runtimes
  } else {
    mergedSignal = timeoutSignal;
  }

  return streamText({
    model: getLanguageModel(route),
    system: systemPrompt,
    prompt: userPrompt,
    maxOutputTokens: route.maxTokens,
    temperature: route.temperature,
    topP: route.topP,
    topK: route.topK,
    presencePenalty: route.presencePenalty,
    frequencyPenalty: route.frequencyPenalty,
    stopSequences: route.stopSequences,
    seed: route.seed,
    maxRetries: route.maxRetries,
    headers: route.headers,
    providerOptions: route.providerOptions,
    abortSignal: mergedSignal,
    onFinish: ({ usage, totalUsage }) => {
      recordCallUsage(route, totalUsage ?? usage);
    },
  });
}

/**
 * 工具循环版流式响应：传入 messages + tools + maxSteps，AI SDK 自动驱动
 * 「模型 call 工具 → 执行 execute → 结果回灌 → 重复」直至产出最终文本。
 * 复用 'query' 等任务路由的采样参数与超时/abort 合并逻辑。
 */
export function streamTextWithTools(
  task: LLMTask,
  opts: {
    system: string;
    messages: ModelMessage[];
    tools: Record<string, Tool>;
    maxSteps: number;
    abortSignal?: AbortSignal;
    overrides?: LLMRouteOverride;
  },
): ReturnType<typeof streamText> {
  // 注：本函数暂无可取消 job 调用方（query 走 streamTextWithTools 但 query 本身
  // 不支持取消）；streamText 同步返回 stream、生命周期不像 generateText 那样能用
  // try/finally 包裹，若未来需要取消支持须额外设计资源释放时机，此处不引入。
  const route = resolveTask(task, opts.overrides ?? {});
  const prefix = `[LLM][Task: ${route.task}][Model: ${route.logLabel}]`;
  console.log(`${prefix} streamText (tools) started, maxSteps=${opts.maxSteps}`);

  const timeoutSignal = AbortSignal.timeout(route.timeoutMs);
  let mergedSignal: AbortSignal;
  if (opts.abortSignal) {
    mergedSignal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([opts.abortSignal, timeoutSignal])
        : opts.abortSignal;
  } else {
    mergedSignal = timeoutSignal;
  }

  return streamText({
    model: getLanguageModel(route),
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    toolChoice: 'auto',
    stopWhen: stepCountIs(opts.maxSteps),
    maxOutputTokens: route.maxTokens,
    temperature: route.temperature,
    topP: route.topP,
    topK: route.topK,
    presencePenalty: route.presencePenalty,
    frequencyPenalty: route.frequencyPenalty,
    stopSequences: route.stopSequences,
    seed: route.seed,
    maxRetries: route.maxRetries,
    headers: route.headers,
    providerOptions: route.providerOptions,
    abortSignal: mergedSignal,
    onFinish: ({ usage, totalUsage }) => {
      recordCallUsage(route, totalUsage ?? usage);
    },
  });
}

/**
 * 工具循环版一次性（非流式）文本生成，供 save-as-page 一次性模式复用。
 */
export async function generateTextWithTools(
  task: LLMTask,
  opts: {
    system: string;
    messages: ModelMessage[];
    tools: Record<string, Tool>;
    maxSteps: number;
    overrides?: LLMRouteOverride;
    /** 每 2s 轮询一次；返回 true 时 abort 当前请求并抛出 AgentCancelled。 */
    shouldCancel?: () => boolean;
    /** 每步结束时对该步每个 tool call 回调一次；回调抛错被吞掉，不影响主流程。 */
    onToolCall?: (info: { tool: string; args: unknown }) => void;
  },
): Promise<{ text: string }> {
  const route = resolveTask(task, opts.overrides ?? {});
  const prefix = `[LLM][Task: ${route.task}][Model: ${route.logLabel}]`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.error(`${prefix} abort: timeout reached after ${route.timeoutMs}ms`);
    controller.abort();
  }, route.timeoutMs);
  const { cleanup: stopCancelPolling, cancelledRef } = startCancelPolling(opts.shouldCancel, controller);

  try {
    const result = await generateText({
      model: getLanguageModel(route),
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(opts.maxSteps),
      maxOutputTokens: route.maxTokens,
      temperature: route.temperature,
      topP: route.topP,
      topK: route.topK,
      presencePenalty: route.presencePenalty,
      frequencyPenalty: route.frequencyPenalty,
      seed: route.seed,
      maxRetries: route.maxRetries,
      headers: route.headers,
      providerOptions: route.providerOptions,
      onStepFinish: opts.onToolCall
        ? (step) => {
            for (const tc of step.toolCalls) {
              try {
                opts.onToolCall!({ tool: tc.toolName, args: tc.input });
              } catch {
                // 观测回调不得影响 LLM 循环
              }
            }
          }
        : undefined,
      abortSignal: controller.signal,
    });
    if (cancelledRef.current) throw new AgentCancelled();
    recordCallUsage(route, result.totalUsage ?? result.usage);
    return { text: result.text };
  } catch (err) {
    if (cancelledRef.current) throw new AgentCancelled();
    throw err;
  } finally {
    clearTimeout(timeoutId);
    stopCancelPolling();
  }
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

/** embedding 任务已配置 model 时返回 true；未配置时返回 false（勿在无 embedding 配置时调用）。 */
export function isEmbeddingConfigured(): boolean {
  return !!getLLMConfig().tasks?.embedding?.model;
}

/**
 * 读时重塑是否可用：reshape:page 能解析出 model 即视为已配置。
 * 走 resolveTask（含 defaults 兜底）——只要配了任意默认模型，重塑即可工作；
 * 无任何配置时回落 false，lens 端点据此优雅降级为直显 canonical。
 */
export function isReshapeConfigured(): boolean {
  try {
    return !!resolveTask('reshape:page').model;
  } catch {
    return false;
  }
}

/** 返回 embedding 任务解析后的 modelId（tasks.embedding.model 或 defaults.model 兜底）。 */
export function embeddingModelId(): string {
  if (!isEmbeddingConfigured()) {
    throw new LLMConfigError('Embedding model not configured (set tasks.embedding.model in llm-config.json)');
  }
  return resolveTask('embedding').model;
}

/** 批量生成文本 embedding，返回 number[][] 向量数组。 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (!isEmbeddingConfigured()) {
    throw new LLMConfigError('Embedding model not configured (set tasks.embedding.model in llm-config.json)');
  }
  const route = resolveTask('embedding');
  const { embeddings, usage } = await embedMany({
    model: getEmbeddingModel(route),
    values: texts,
  });
  recordCallUsage(route, { inputTokens: usage?.tokens, outputTokens: 0 });
  return embeddings;
}
