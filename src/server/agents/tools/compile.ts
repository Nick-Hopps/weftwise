import { tool, type ToolSet } from 'ai';
import type { ZodSchema } from 'zod';
import type { ToolDef } from '../types';
import type { ToolContext } from './tool-context';

export const FINISH_TOOL_NAME = 'finish';

/**
 * Map an internal tool name to a provider-safe function name.
 *
 * Provider APIs (OpenAI / DeepSeek / xAI / Mistral / …) require tool names to
 * match `^[a-zA-Z0-9_-]{1,64}$`. Our internal names use dots for namespacing
 * (`vault.read`, `dispatch.skill`), so any non-conforming
 * character becomes `_`, the result is capped at 64 chars, and collisions are
 * disambiguated with a numeric suffix.
 */
export function toProviderToolName(name: string, used: Set<string>): string {
  let base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (base.length === 0) base = 'tool';

  if (!used.has(base)) return base;

  for (let i = 2; ; i += 1) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

/** 把内部 ToolDef 编译成 provider 可用 ToolSet；步数/事件通过 opts 注入（ingest 传，query 不传）。 */
export function compileToolSet(
  toolDefs: ToolDef[],
  ctx: ToolContext,
  opts?: {
    chargeStep?(): void;
    onToolCall?(info: { tool: string; input: unknown; output?: unknown; error?: string; durationMs: number }): void;
  },
): ToolSet {
  const toolSet: ToolSet = {};
  const used = new Set<string>();
  for (const t of toolDefs) {
    const providerName = toProviderToolName(t.name, used);
    used.add(providerName);
    toolSet[providerName] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (args: unknown) => {
        const start = Date.now();
        opts?.chargeStep?.();
        try {
          const out = await t.handler(args, ctx);
          opts?.onToolCall?.({ tool: t.name, input: args, output: out, durationMs: Date.now() - start });
          return out;
        } catch (err) {
          opts?.onToolCall?.({ tool: t.name, input: args, error: (err as Error).message, durationMs: Date.now() - start });
          throw err;
        }
      },
    });
  }
  return toolSet;
}

/** 合成终结工具：其 parameters = skill outputSchema；模型调用它即产出结构化结果（经 capture 回传）。 */
export function synthesizeFinishTool(schema: ZodSchema, capture: (value: unknown) => void): ToolSet {
  return {
    [FINISH_TOOL_NAME]: tool({
      description: 'Submit the final structured result. Call this exactly once when done; do not answer in plain text.',
      inputSchema: schema,
      execute: async (args: unknown) => {
        capture(args);
        return { accepted: true };
      },
    }),
  };
}
