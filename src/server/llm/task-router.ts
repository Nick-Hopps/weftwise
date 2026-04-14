import type { JSONValue } from '@ai-sdk/provider';
import { getLLMConfig } from './config-loader';
import type { LLMRouteOverride, LLMTask, ResolvedTaskRoute } from './config-schema';
import { LLMConfigError } from './errors';

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes

/**
 * Resolve a task to a fully-qualified route by merging:
 *   defaults ← task config ← call-site overrides
 */
export function resolveTask(
  task: LLMTask,
  overrides: LLMRouteOverride = {},
): ResolvedTaskRoute {
  const config = getLLMConfig();
  const taskConfig = config.tasks[task] ?? {};

  // Merge: defaults < task < overrides (later wins)
  const merged = {
    ...config.defaults,
    ...stripUndefined(taskConfig),
    ...stripUndefined(overrides),
  };

  if (!merged.profile) {
    throw new LLMConfigError(
      `Task "${task}" resolved without a provider profile. ` +
        'Check defaults.profile in llm-config.json.',
    );
  }

  if (!merged.model) {
    throw new LLMConfigError(
      `Task "${task}" resolved without a model. ` +
        'Check defaults.model in llm-config.json.',
    );
  }

  const provider = config.providers[merged.profile];
  if (!provider) {
    throw new LLMConfigError(
      `Task "${task}" references unknown provider profile "${merged.profile}". ` +
        `Available profiles: ${Object.keys(config.providers).join(', ')}`,
    );
  }

  const logLabel =
    provider.provider === 'openai-compatible'
      ? `${provider.name}:${merged.model}`
      : `${provider.provider}:${merged.model}`;

  return {
    task,
    profileName: merged.profile,
    provider,
    model: merged.model,

    // AI SDK CallSettings
    maxTokens: merged.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: merged.temperature,
    topP: merged.topP,
    topK: merged.topK,
    presencePenalty: merged.presencePenalty,
    frequencyPenalty: merged.frequencyPenalty,
    stopSequences: merged.stopSequences,
    seed: merged.seed,
    maxRetries: merged.maxRetries,
    headers: merged.headers,

    // Provider-specific
    providerOptions: merged.providerOptions as unknown as Record<string, Record<string, JSONValue>> | undefined,

    // App-level
    timeoutMs: merged.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    logLabel,
  };
}

/** Remove keys whose value is undefined so they don't clobber defaults. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result as Partial<T>;
}
