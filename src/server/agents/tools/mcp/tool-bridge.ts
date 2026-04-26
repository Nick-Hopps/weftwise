import { z } from 'zod';
import { convertJsonSchemaToZod } from 'zod-from-json-schema';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDef } from '../../types';

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export async function bridgeServerTools(
  serverId: string,
  client: Client,
): Promise<ToolDef[]> {
  const list = await client.listTools();
  const out: ToolDef[] = [];
  for (const tool of list.tools as McpToolDescriptor[]) {
    let inputSchema: z.ZodSchema;
    try {
      inputSchema = convertJsonSchemaToZod(tool.inputSchema as object) as unknown as z.ZodSchema;
    } catch {
      inputSchema = z.record(z.string(), z.unknown());
    }
    const def: ToolDef = {
      name: `mcp.${serverId}.${tool.name}`,
      source: 'mcp',
      description: tool.description ?? `MCP tool ${serverId}/${tool.name}`,
      inputSchema,
      outputSchema: z.unknown() as z.ZodSchema,
      sideEffect: 'none',
      async handler(input) {
        const result = await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
        return result.content;
      },
    };
    out.push(def);
  }
  return out;
}
