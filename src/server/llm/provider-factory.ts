import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import type { EmbeddingModel, LanguageModel } from 'ai';
import type { LLMProviderProfile, ResolvedTaskRoute } from './config-schema';
import { LLMConfigError, LLMProviderError } from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LanguageModelFactory = (modelId: string) => LanguageModel;

// ---------------------------------------------------------------------------
// Provider instance cache (keyed by profile name)
// ---------------------------------------------------------------------------

const factoryCache = new Map<string, LanguageModelFactory>();

export function resetProviderFactoryCache(): void {
  factoryCache.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create (or retrieve cached) LanguageModel for a resolved task route. */
export function getLanguageModel(route: ResolvedTaskRoute): LanguageModel {
  const factory = getOrCreateFactory(route.profileName, route.provider);
  return factory(route.model);
}

/**
 * 取 embedding 模型。仅 OpenAI 家族（openai / openai-compatible / ollama）支持；
 * 其余 provider 抛错（embedding 应配到这些 profile）。
 */
export function getEmbeddingModel(route: ResolvedTaskRoute): EmbeddingModel<string> {
  const profile = route.provider;
  switch (profile.provider) {
    case 'openai': {
      const p = createOpenAI({
        apiKey: requireApiKey(route.profileName, profile.apiKeyEnv),
        baseURL: profile.baseURL,
      });
      return p.textEmbeddingModel(route.model);
    }
    case 'ollama': {
      const p = createOpenAICompatible({
        name: 'ollama',
        apiKey: optionalApiKey(profile.apiKeyEnv) ?? 'ollama',
        baseURL: ensureV1(profile.baseURL),
      });
      return p.textEmbeddingModel(route.model);
    }
    case 'openai-compatible': {
      const p = createOpenAICompatible({
        name: profile.name,
        apiKey: optionalApiKey(profile.apiKeyEnv),
        baseURL: profile.baseURL,
        headers: profile.headers,
      });
      return p.textEmbeddingModel(route.model);
    }
    default:
      throw new LLMProviderError(
        `Provider "${profile.provider}" does not support embeddings; configure tasks.embedding to an openai / openai-compatible / ollama profile`,
      );
  }
}

// ---------------------------------------------------------------------------
// Factory creation
// ---------------------------------------------------------------------------

function getOrCreateFactory(
  profileName: string,
  profile: LLMProviderProfile,
): LanguageModelFactory {
  const cached = factoryCache.get(profileName);
  if (cached) return cached;

  const factory = buildFactory(profileName, profile);
  factoryCache.set(profileName, factory);
  return factory;
}

function buildFactory(
  profileName: string,
  profile: LLMProviderProfile,
): LanguageModelFactory {
  try {
    switch (profile.provider) {
      case 'anthropic': {
        const p = createAnthropic({
          apiKey: requireApiKey(profileName, profile.apiKeyEnv),
          baseURL: profile.baseURL,
          // 兼容代理（如 packyapi / taluna）的 Anthropic 端点：请求侧补显式
          // stream:false（非流式调用缺失该字段会被中转拒绝），响应侧给缺
          // signature 的 thinking 块补占位值（否则被 @ai-sdk/anthropic 响应
          // schema 拒绝）。
          fetch: createAnthropicCompatRepairFetch(),
        });
        return (id) => p(id);
      }

      case 'openai': {
        const p = createOpenAI({
          apiKey: requireApiKey(profileName, profile.apiKeyEnv),
          baseURL: profile.baseURL,
        });
        return (id) => p(id);
      }

      case 'google': {
        const p = createGoogleGenerativeAI({
          apiKey: requireApiKey(profileName, profile.apiKeyEnv),
          baseURL: profile.baseURL,
        });
        return (id) => p(id);
      }

      case 'deepseek': {
        const p = createDeepSeek({
          apiKey: requireApiKey(profileName, profile.apiKeyEnv),
          baseURL: profile.baseURL,
        });
        return (id) => p(id);
      }

      case 'mistral': {
        const p = createMistral({
          apiKey: requireApiKey(profileName, profile.apiKeyEnv),
          baseURL: profile.baseURL,
        });
        return (id) => p(id);
      }

      case 'xai': {
        const p = createXai({
          apiKey: requireApiKey(profileName, profile.apiKeyEnv),
          baseURL: profile.baseURL,
        });
        return (id) => p(id);
      }

      case 'ollama': {
        const p = createOpenAICompatible({
          name: 'ollama',
          apiKey: optionalApiKey(profile.apiKeyEnv) ?? 'ollama',
          baseURL: ensureV1(profile.baseURL),
        });
        return (id) => p.chatModel(id);
      }

      case 'openai-compatible': {
        const p = createOpenAICompatible({
          name: profile.name,
          apiKey: optionalApiKey(profile.apiKeyEnv),
          baseURL: profile.baseURL,
          headers: profile.headers,
        });
        return (id) => p.chatModel(id);
      }

      default: {
        const _exhaustive: never = profile;
        throw new LLMProviderError(
          `Unsupported provider: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof LLMConfigError || err instanceof LLMProviderError) {
      throw err;
    }
    throw new LLMProviderError(
      `Failed to initialize provider profile "${profileName}" (${profile.provider}). ` +
        `Check your llm-config.json and .env settings.`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 修复 Anthropic 兼容代理（如 packyapi）的非流式响应：其 `thinking` 内容块缺少
 * `signature` 字段，而 @ai-sdk/anthropic 的响应 schema 要求 `signature` 为必填 string，
 * 否则整个响应在 SDK 校验层被拒（AI_APICallError: Invalid JSON response），工具调用
 * 也随之失败。这里给缺失 signature 的 thinking 块补占位空串使响应过校验；仅在缺失时
 * 改写（真 Anthropic 自带 signature → no-op）。流式响应（text/event-stream）原样透传。
 */
function createAnthropicCompatRepairFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    // 请求侧：非流式 messages 请求缺 stream 字段时补显式 stream:false
    //（taluna 中转硬性要求；官方 API 对多余的 stream:false 无感知，安全）。
    if (init && typeof init.body === 'string') {
      const patched = ensureExplicitStreamFlag(init.body);
      if (patched !== null) init = { ...init, body: patched };
    }
    const res = await baseFetch(input, init);
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return res; // SSE 流式透传

    // 读副本探测，原 res 不消费——绝大多数响应（无 thinking 块）原样透传，零开销/零回归。
    const raw = await res.clone().text();
    if (!raw.includes('"thinking"')) return res;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return res;
    }
    if (!injectMissingThinkingSignatures(body)) return res;
    return rebuildJsonResponse(JSON.stringify(body), res);
  };
}

/**
 * 请求体缺失 `stream` 字段时补 `stream:false`，返回改写后的 body 文本；
 * 已显式携带 stream（true/false）或 body 不是 JSON 对象时返回 null（不改写）。
 * 背景：taluna 等中转要求非流式 messages 请求显式 stream:false，而 AI SDK
 * 的 generateObject/generateText 非流式调用不带该字段。
 */
export function ensureExplicitStreamFlag(bodyText: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if ('stream' in body) return null;
  return JSON.stringify({ ...body, stream: false });
}

/** 给响应 body 里所有缺失 signature 的 thinking 块补空串；返回是否改动过。 */
export function injectMissingThinkingSignatures(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  let mutated = false;
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'thinking' &&
      typeof (block as { signature?: unknown }).signature !== 'string'
    ) {
      (block as { signature: string }).signature = '';
      mutated = true;
    }
  }
  return mutated;
}

/** 用改写后的 body 文本重建 Response，保留状态码，去掉失真的 content-length。 */
function rebuildJsonResponse(bodyText: string, original: Response): Response {
  const headers = new Headers(original.headers);
  headers.delete('content-length');
  return new Response(bodyText, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function requireApiKey(profileName: string, envName: string | undefined): string {
  if (!envName) {
    throw new LLMConfigError(
      `Provider profile "${profileName}" requires "apiKeyEnv" but none was configured in llm-config.json.`,
    );
  }
  const value = process.env[envName];
  if (!value) {
    throw new LLMConfigError(
      `Missing credentials for provider profile "${profileName}". ` +
        `Environment variable "${envName}" is not set.\n` +
        `Fix: Add ${envName}=your_api_key to your .env file and restart.`,
    );
  }
  return value;
}

function optionalApiKey(envName: string | undefined): string | undefined {
  if (!envName) return undefined;
  return process.env[envName] || undefined;
}

function ensureV1(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}
