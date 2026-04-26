import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

const StdioServer = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const HttpServer = z.object({
  transport: z.literal('streamable-http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const ServerSchema = z.discriminatedUnion('transport', [StdioServer, HttpServer]);

export const McpConfigSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ServerSchema).default({}),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpServerConfig = z.infer<typeof ServerSchema>;

export function loadMcpConfig(path: string): McpConfig {
  if (!existsSync(path)) {
    return { version: 1, servers: {} };
  }
  const raw = readFileSync(path, 'utf8');
  return McpConfigSchema.parse(JSON.parse(raw));
}
