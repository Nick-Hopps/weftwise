import type { ToolDef, ToolRegistry } from '../../types';
import { connectServer, type McpClientHandle } from './transport';
import { bridgeServerTools } from './tool-bridge';
import type { McpConfig, McpServerConfig } from './config';
import type { AgentMcpLifecycle } from '@/lib/contracts';

interface PoolEntry {
  handle: McpClientHandle | null;
  tools: ToolDef[];
  status: 'cold' | 'connecting' | 'ready' | 'dead';
  error?: string;
}

export interface McpPool {
  registerToolPlaceholders(registry: ToolRegistry): void;
  startEager(): Promise<void>;
  closeAfterJob(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createMcpPool(opts: {
  config: McpConfig;
  lifecycle: AgentMcpLifecycle;
  toolRegistry: ToolRegistry;
}): McpPool {
  const entries = new Map<string, PoolEntry>();
  for (const serverId of Object.keys(opts.config.servers)) {
    entries.set(serverId, { handle: null, tools: [], status: 'cold' });
  }

  async function ensureConnected(serverId: string, cfg: McpServerConfig): Promise<PoolEntry> {
    const entry = entries.get(serverId)!;
    if (entry.status === 'ready') return entry;
    if (entry.status === 'connecting') {
      while (entry.status === 'connecting') await new Promise(r => setTimeout(r, 25));
      return entry;
    }
    entry.status = 'connecting';
    try {
      const handle = await connectServer(serverId, cfg);
      const tools = await bridgeServerTools(serverId, handle.client);
      entry.handle = handle;
      entry.tools = tools;
      entry.status = 'ready';
      for (const t of tools) {
        try { opts.toolRegistry.register(t); } catch { /* already registered: keep latest */ }
      }
    } catch (e) {
      entry.status = 'dead';
      entry.error = (e as Error).message;
    }
    return entry;
  }

  function makeProxyTool(serverId: string, cfg: McpServerConfig, name: string): ToolDef {
    return {
      name,
      source: 'mcp',
      description: `MCP tool from server "${serverId}" (lazy)`,
      inputSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) } as unknown as ToolDef['inputSchema'],
      outputSchema: { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }) } as unknown as ToolDef['outputSchema'],
      sideEffect: 'none',
      async handler(input) {
        const entry = await ensureConnected(serverId, cfg);
        if (entry.status === 'dead' || !entry.handle) {
          throw new Error(`MCP server "${serverId}" unavailable: ${entry.error ?? 'unknown'}`);
        }
        const real = entry.tools.find(t => t.name === name);
        if (!real) {
          throw new Error(`MCP server "${serverId}" did not advertise tool ${name}`);
        }
        return real.handler(input, undefined as never);
      },
    };
  }

  return {
    registerToolPlaceholders(registry) {
      for (const [serverId, cfg] of Object.entries(opts.config.servers)) {
        const proxyName = `mcp.${serverId}.__namespace__`;
        try {
          registry.register(makeProxyTool(serverId, cfg, proxyName));
        } catch { /* duplicate */ }
      }
    },
    async startEager() {
      if (opts.lifecycle !== 'eager') return;
      await Promise.all(Object.entries(opts.config.servers).map(([id, cfg]) => ensureConnected(id, cfg)));
    },
    async closeAfterJob() {
      if (opts.lifecycle !== 'per-job') return;
      for (const [, entry] of entries) {
        if (entry.handle) {
          try { await entry.handle.close(); } catch { /* ignore */ }
          entry.handle = null;
          entry.status = 'cold';
          entry.tools = [];
        }
      }
    },
    async shutdown() {
      for (const [, entry] of entries) {
        if (entry.handle) {
          try { await entry.handle.close(); } catch { /* ignore */ }
        }
      }
      entries.clear();
    },
  };
}
