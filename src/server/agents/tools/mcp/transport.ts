import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './config';

export interface McpClientHandle {
  client: Client;
  close: () => Promise<void>;
}

export async function connectServer(serverId: string, cfg: McpServerConfig): Promise<McpClientHandle> {
  const client = new Client({ name: `agentic-wiki:${serverId}`, version: '1.0.0' }, { capabilities: {} });

  if (cfg.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      ...(cfg.env ? { env: cfg.env } : {}),
    });
    await client.connect(transport);
    return {
      client,
      close: async () => { await transport.close(); },
    };
  }

  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers: cfg.headers },
  });
  await client.connect(transport);
  return {
    client,
    close: async () => { await transport.close(); },
  };
}
