import fs from 'fs';
import path from 'path';
import { LLMConfigError } from './errors';
import {
  LLMConfigFileSchema,
  type LLMConfigFile,
  type LLMTask,
} from './config-schema';

// ---------------------------------------------------------------------------
// Config cache
// ---------------------------------------------------------------------------

let cachedConfig: LLMConfigFile | null = null;

export function getLLMConfigPath(): string {
  return path.resolve(process.cwd(), 'llm-config.json');
}

export function resetLLMConfigCache(): void {
  cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export function getLLMConfig(): LLMConfigFile {
  if (cachedConfig) return cachedConfig;

  const filePath = getLLMConfigPath();

  if (!fs.existsSync(filePath)) {
    throw new LLMConfigError(
      `llm-config.json not found at ${filePath}.\n` +
        'Copy llm-config.example.json to llm-config.json and configure your providers.',
    );
  }

  cachedConfig = loadFromJsonFile(filePath);
  logRouteTable(cachedConfig);
  validateApiKeysAtBoot(cachedConfig);
  return cachedConfig;
}

// ---------------------------------------------------------------------------
// JSON file loader
// ---------------------------------------------------------------------------

function loadFromJsonFile(filePath: string): LLMConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new LLMConfigError(`Failed to parse ${filePath}`, err);
  }

  const result = LLMConfigFileSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new LLMConfigError(`Invalid llm-config.json:\n${details}`);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Boot-time route table log
// ---------------------------------------------------------------------------

function resolveTaskLabel(
  config: LLMConfigFile,
  task: LLMTask,
): { provider: string; model: string } {
  const taskCfg = config.tasks[task];
  const profileName = taskCfg?.profile ?? config.defaults.profile;
  const model = taskCfg?.model ?? config.defaults.model;
  const profile = config.providers[profileName];
  const providerLabel =
    profile?.provider === 'openai-compatible'
      ? `openai-compatible(${profile.name})`
      : profile?.provider ?? 'unknown';
  return { provider: providerLabel, model };
}

function logRouteTable(config: LLMConfigFile): void {
  const tasks: LLMTask[] = ['ingest', 'query', 'lint'];
  const defaultProfile = config.providers[config.defaults.profile];
  const defaultProvider =
    defaultProfile?.provider === 'openai-compatible'
      ? `openai-compatible(${defaultProfile.name})`
      : defaultProfile?.provider ?? 'unknown';

  console.log('[LLM Router] Configuration loaded from llm-config.json.');
  console.log('[LLM Router] -------------------------------------------------------');
  console.log('[LLM Router] Task       | Provider          | Model');
  console.log('[LLM Router] -------------------------------------------------------');
  console.log(
    `[LLM Router] default    | ${defaultProvider.padEnd(17)} | ${config.defaults.model}`,
  );

  for (const task of tasks) {
    const { provider, model } = resolveTaskLabel(config, task);
    console.log(
      `[LLM Router] ${task.padEnd(10)} | ${provider.padEnd(17)} | ${model}`,
    );
  }

  console.log('[LLM Router] -------------------------------------------------------');
}

// ---------------------------------------------------------------------------
// Boot-time API key validation
// ---------------------------------------------------------------------------

function validateApiKeysAtBoot(config: LLMConfigFile): void {
  const tasks: LLMTask[] = ['ingest', 'query', 'lint'];
  const checkedProfiles = new Set<string>();
  const missing: string[] = [];

  // Collect all profiles that will be used by active tasks + default
  const activeProfiles = new Set<string>();
  activeProfiles.add(config.defaults.profile);
  for (const task of tasks) {
    const taskCfg = config.tasks[task];
    activeProfiles.add(taskCfg?.profile ?? config.defaults.profile);
  }

  for (const profileName of activeProfiles) {
    if (checkedProfiles.has(profileName)) continue;
    checkedProfiles.add(profileName);

    const profile = config.providers[profileName];
    if (!profile) continue;

    // Ollama and openai-compatible don't always require API keys
    if (profile.provider === 'ollama') continue;
    if (profile.provider === 'openai-compatible' && !profile.apiKeyEnv) continue;

    const envName = profile.apiKeyEnv;
    if (envName && !process.env[envName]) {
      missing.push(
        `  - Profile "${profileName}" (${profile.provider}): ${envName} is not set`,
      );
    }
  }

  if (missing.length > 0) {
    const msg =
      `[LLM Router] WARNING: Missing API keys for active provider profiles:\n` +
      missing.join('\n') +
      `\n[LLM Router] LLM calls will fail at runtime. Add the missing keys to your .env file.`;
    console.warn(msg);
  }
}
