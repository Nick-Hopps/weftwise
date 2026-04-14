import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
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
