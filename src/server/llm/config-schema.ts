import type { JSONValue } from '@ai-sdk/provider';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const BUILTIN_LLM_TASKS = ['query', 'lint', 'merge', 'split', 'embedding', 'curate', 'fix'] as const;
// 多阶段流水线的某一阶段用 `<pipeline>:<stage>` 形式的 task key（如 `ingest:planner`），
// 由 agent-loop 从 skill id（`ingest-planner`）派生（见 skillTaskKey）。开放命名空间。
export const LLMTaskSchema = z.string().refine(
  (s) => (BUILTIN_LLM_TASKS as readonly string[]).includes(s) || /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(s),
  { message: "Task must be 'query', 'lint', 'merge', 'split', 'curate', 'fix', 'embedding', or a pipeline stage '<pipeline>:<stage>' (e.g. 'ingest:planner')" },
);

export const LLMProviderKindSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'mistral',
  'xai',
  'ollama',
  'openai-compatible',
]);

// ---------------------------------------------------------------------------
// Provider profile schemas (discriminated union on `provider`)
// ---------------------------------------------------------------------------

const BaseProviderProfileSchema = z.object({
  apiKeyEnv: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
});

export const AnthropicProfileSchema = BaseProviderProfileSchema.extend({
  provider: z.literal('anthropic'),
});

export const OpenAIProfileSchema = BaseProviderProfileSchema.extend({
  provider: z.literal('openai'),
});

export const GoogleProfileSchema = BaseProviderProfileSchema.extend({
  provider: z.literal('google'),
});

export const DeepSeekProfileSchema = BaseProviderProfileSchema.extend({
  provider: z.literal('deepseek'),
});

export const MistralProfileSchema = BaseProviderProfileSchema.extend({
  provider: z.literal('mistral'),
});

export const XAIProfileSchema = BaseProviderProfileSchema.extend({
  provider: z.literal('xai'),
});

export const OllamaProfileSchema = z.object({
  provider: z.literal('ollama'),
  apiKeyEnv: z.string().min(1).optional(),
  baseURL: z.string().url().default('http://localhost:11434'),
});

export const OpenAICompatibleProfileSchema = z.object({
  provider: z.literal('openai-compatible'),
  name: z.string().min(1),
  apiKeyEnv: z.string().min(1).optional(),
  baseURL: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const LLMProviderProfileSchema = z.discriminatedUnion('provider', [
  AnthropicProfileSchema,
  OpenAIProfileSchema,
  GoogleProfileSchema,
  DeepSeekProfileSchema,
  MistralProfileSchema,
  XAIProfileSchema,
  OllamaProfileSchema,
  OpenAICompatibleProfileSchema,
]);

// ---------------------------------------------------------------------------
// Shared JSON value schema (for providerOptions)
// ---------------------------------------------------------------------------

const JSONValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JSONValueSchema),
    z.record(z.string(), JSONValueSchema),
  ]),
);

// ---------------------------------------------------------------------------
// Route config (per-task overrides + defaults)
// ---------------------------------------------------------------------------

export const LLMRouteConfigSchema = z.object({
  profile: z.string().min(1).optional(),
  model: z.string().min(1).optional(),

  // --- AI SDK CallSettings ---
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  presencePenalty: z.number().min(-1).max(1).optional(),
  frequencyPenalty: z.number().min(-1).max(1).optional(),
  stopSequences: z.array(z.string()).optional(),
  seed: z.number().int().optional(),
  maxRetries: z.number().int().min(0).optional(),
  headers: z.record(z.string(), z.string()).optional(),

  // --- Provider-specific options (e.g. Anthropic thinking, OpenAI style) ---
  providerOptions: z.record(z.string(), z.record(z.string(), JSONValueSchema)).optional(),

  // --- App-level settings ---
  timeoutMs: z.number().int().positive().optional(),
});

export const LLMDefaultRouteConfigSchema = LLMRouteConfigSchema.extend({
  profile: z.string().min(1),
  model: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Top-level config file schema
// ---------------------------------------------------------------------------

export const LLMConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    defaults: LLMDefaultRouteConfigSchema,
    tasks: z.record(LLMTaskSchema, LLMRouteConfigSchema).default({}),
    providers: z.record(z.string().min(1), LLMProviderProfileSchema),
  })
  .superRefine((config, ctx) => {
    const checkProfileRef = (
      profileName: string | undefined,
      path: (string | number)[],
    ) => {
      if (!profileName) return;
      if (!config.providers[profileName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown provider profile "${profileName}". Available: ${Object.keys(config.providers).join(', ')}`,
          path,
        });
      }
    };

    checkProfileRef(config.defaults.profile, ['defaults', 'profile']);
    for (const [taskKey, taskConfig] of Object.entries(config.tasks ?? {})) {
      checkProfileRef(taskConfig?.profile, ['tasks', taskKey, 'profile']);
    }
  });

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type LLMTask = z.infer<typeof LLMTaskSchema>;
export type LLMProviderKind = z.infer<typeof LLMProviderKindSchema>;
export type LLMProviderProfile = z.infer<typeof LLMProviderProfileSchema>;
export type LLMRouteOverride = z.infer<typeof LLMRouteConfigSchema>;
export type LLMDefaultRouteConfig = z.infer<typeof LLMDefaultRouteConfigSchema>;
export type LLMConfigFile = z.infer<typeof LLMConfigFileSchema>;

/** Fully resolved route ready for provider instantiation. */
export interface ResolvedTaskRoute {
  task: LLMTask;
  profileName: string;
  provider: LLMProviderProfile;
  model: string;

  // AI SDK CallSettings
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  maxRetries?: number;
  headers?: Record<string, string>;

  // Provider-specific options
  providerOptions?: Record<string, Record<string, JSONValue>>;

  // App-level
  timeoutMs: number;
  /** Human-readable label for logging, e.g. "anthropic:claude-sonnet-4-6" */
  logLabel: string;
}
