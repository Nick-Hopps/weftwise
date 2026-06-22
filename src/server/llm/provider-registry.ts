import { embedMany, generateObject, streamText } from 'ai';
import type { LanguageModel } from 'ai';
import type { ZodType } from 'zod';
import type { LLMRouteOverride, LLMTask, ResolvedTaskRoute } from './config-schema';
import { getLLMConfig } from './config-loader';
import { getEmbeddingModel, getLanguageModel } from './provider-factory';
import { resolveTask } from './task-router';
import { LLMConfigError } from './errors';

export function resolveModel(route: ResolvedTaskRoute): LanguageModel {
  return getLanguageModel(route);
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
    const result = await generateObject({
      model: getLanguageModel(route),
      schema,
      system: systemPrompt,
      prompt: userPrompt,
      maxTokens: route.maxTokens,
      temperature: route.temperature,
      topP: route.topP,
      topK: route.topK,
      presencePenalty: route.presencePenalty,
      frequencyPenalty: route.frequencyPenalty,
      seed: route.seed,
      maxRetries: route.maxRetries,
      headers: route.headers,
      providerOptions: route.providerOptions,
      abortSignal: controller.signal,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${prefix} done in ${elapsed}s | tokens: in=${result.usage?.promptTokens ?? 'n/a'} out=${result.usage?.completionTokens ?? 'n/a'}`,
    );
    return result.object;
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
    maxTokens: route.maxTokens,
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
  });
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

/** embedding 任务已配置 model 时返回 true；未配置时返回 false（勿在无 embedding 配置时调用）。 */
export function isEmbeddingConfigured(): boolean {
  return !!getLLMConfig().tasks?.embedding?.model;
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
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(route),
    values: texts,
  });
  return embeddings;
}
