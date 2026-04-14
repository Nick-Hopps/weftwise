import path from 'path';
import { z } from 'zod';

const EnvSchema = z.object({
  VAULT_PATH: z.string().default('./data/vault'),
  DATABASE_PATH: z.string().default('./data/wiki.db'),
  WIKI_API_KEY: z.string().optional(),
});

export interface AppConfig {
  vaultPath: string;
  databasePath: string;
}

let config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!config) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid environment configuration:\n${errors}`);
    }
    const env = parsed.data;
    config = {
      vaultPath: path.resolve(env.VAULT_PATH),
      databasePath: path.resolve(env.DATABASE_PATH),
    };
  }
  return config;
}

// Helper to get vault sub-paths
export function vaultPath(...segments: string[]): string {
  return path.join(getConfig().vaultPath, ...segments);
}
