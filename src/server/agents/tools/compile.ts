import { tool, type ToolSet } from 'ai';
import type { ZodSchema } from 'zod';
import type { ToolDef } from '../types';
import type { ToolContext } from './tool-context';
import { resolveToolProfile, type ToolExecutionPolicy } from './profiles';
import { emptyWikiInspection } from './evidence-results';

export const FINISH_TOOL_NAME = 'finish';

/**
 * Map an internal tool name to a provider-safe function name.
 *
 * Provider APIs (OpenAI / DeepSeek / xAI / Mistral / …) require tool names to
 * match `^[a-zA-Z0-9_-]{1,64}$`. Our internal names use dots for namespacing
 * (`wiki.read`, `source.search`), so any non-conforming
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
  opts: {
    policy: ToolExecutionPolicy;
    chargeStep?(): void;
    onToolCall?(info: {
      profileId: ToolExecutionPolicy['profileId'];
      tool: string;
      sideEffect: ToolDef['sideEffect'];
      subjectId: string;
      pageSlugs: string[];
      input: unknown;
      output?: unknown;
      error?: string;
      durationMs: number;
    }): void;
  },
): ToolSet {
  if (ctx.subject.id !== opts.policy.subjectId) {
    throw new Error(`[TOOL_NOT_ALLOWED] ToolContext subject ${ctx.subject.id} does not match policy subject ${opts.policy.subjectId}`);
  }

  const profile = resolveToolProfile(opts.policy.profileId, { webSearchConfigured: true });
  const allowedTools = new Set(profile.tools);
  const policyCtx = scopeToolContext(ctx, opts.policy);
  const toolSet: ToolSet = {};
  const used = new Set<string>();
  for (const t of toolDefs) {
    if (!allowedTools.has(t.name)) continue;
    if (!opts.policy.allowedSideEffects.has(t.sideEffect)) {
      throw new Error(`[SIDE_EFFECT_NOT_ALLOWED] ${t.name} (${t.sideEffect}) is not allowed by ${opts.policy.profileId}`);
    }
    assertJobCapability(t, opts.policy);
    const providerName = toProviderToolName(t.name, used);
    used.add(providerName);
    toolSet[providerName] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async (args: unknown) => {
        const start = Date.now();
        opts.chargeStep?.();
        const audit = {
          profileId: opts.policy.profileId,
          tool: t.name,
          sideEffect: t.sideEffect,
          subjectId: opts.policy.subjectId,
          pageSlugs: extractPageSlugs(t.name, args),
          input: sanitizeToolAuditInput(t.name, args),
        };
        try {
          const out = await t.handler(args, policyCtx);
          opts.onToolCall?.({
            ...audit,
            output: sanitizeToolAuditOutput(t.name, out),
            durationMs: Date.now() - start,
          });
          return out;
        } catch (err) {
          opts.onToolCall?.({ ...audit, error: (err as Error).message, durationMs: Date.now() - start });
          throw err;
        }
      },
    });
  }
  return toolSet;
}

function assertJobCapability(toolDef: ToolDef, policy: ToolExecutionPolicy): void {
  const expectedJobType = policy.profileId.startsWith('fix:')
    ? 'fix'
    : policy.profileId.startsWith('curate:')
      ? 'curate'
      : null;
  if (!expectedJobType || toolDef.sideEffect === 'none' || toolDef.sideEffect === 'propose') return;
  if (!policy.jobCapability || policy.jobCapability.jobType !== expectedJobType) {
    throw new Error(
      `[TOOL_NOT_ALLOWED] ${toolDef.name} requires a ${expectedJobType} job capability for ${policy.profileId}`,
    );
  }
}

const SENSITIVE_AUDIT_KEYS = new Set([
  'body',
  'content',
  'markdown',
  'text',
  'excerpt',
  'oldString',
  'newString',
  'displayText',
  'diff',
]);

function sanitizeAuditValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_AUDIT_KEYS.has(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, sanitizeAuditValue(entryValue, entryKey)]),
  );
}

function sanitizeToolAuditInput(toolName: string, input: unknown): unknown {
  if (toolName !== 'wiki.metadata.patch' || !input || typeof input !== 'object') {
    return sanitizeAuditValue(input);
  }
  const value = input as Record<string, unknown>;
  const fields = ['title', 'summary', 'tags', 'aliases']
    .filter((field) => value[field] !== undefined);
  return {
    slug: typeof value.slug === 'string' ? value.slug : '',
    fields,
  };
}

function sanitizeToolAuditOutput(toolName: string, output: unknown): unknown {
  if (!output || typeof output !== 'object') return sanitizeAuditValue(output);
  const fields = toolName === 'wiki.metadata.patch'
    ? ['ok', 'updatedSlug', 'referencesUpdated', 'changedFields']
    : toolName === 'wiki.link.ensure'
      ? ['ok', 'updatedSlug', 'mode', 'targetSubjectSlug', 'targetSlug']
      : null;
  if (!fields) return sanitizeAuditValue(output);
  const value = output as Record<string, unknown>;
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
      .map((field) => [field, sanitizeAuditValue(value[field], field)]),
  );
}

function scopeToolContext(ctx: ToolContext, policy: ToolExecutionPolicy): ToolContext {
  const allowed = policy.allowedPageSlugs;
  if (!allowed) return ctx;

  const assertAllowed = (slugs: string[]) => {
    const outside = slugs.find((slug) => !allowed.has(slug));
    if (outside) throw new Error(`[PAGE_OUT_OF_SCOPE] ${outside} is outside ${policy.profileId}`);
  };

  return {
    ...ctx,
    async readPage(slug) {
      if (!allowed.has(slug)) return null;
      return ctx.readPage(slug);
    },
    async search(query, limit) {
      return (await ctx.search(query, limit)).filter((page) => allowed.has(page.slug));
    },
    inspectPage: ctx.inspectPage && (async (slug, include) => {
      if (!allowed.has(slug)) return emptyWikiInspection();
      return ctx.inspectPage!(slug, include);
    }),
    searchSources: ctx.searchSources && (async (input) => {
      if (input.pageSlug && !allowed.has(input.pageSlug)) {
        throw new Error(`[PAGE_OUT_OF_SCOPE] ${input.pageSlug} is outside ${policy.profileId}`);
      }
      return ctx.searchSources!(input);
    }),
    async listPages(input) {
      return ctx.listPages(input, { allowedPageSlugs: allowed });
    },
    mergePages: ctx.mergePages && (async (targetSlug, sourceSlug) => {
      assertAllowed([targetSlug, sourceSlug]);
      return ctx.mergePages!(targetSlug, sourceSlug);
    }),
    splitPage: ctx.splitPage && (async (slug, hint) => {
      assertAllowed([slug]);
      return ctx.splitPage!(slug, hint);
    }),
    deletePage: ctx.deletePage && (async (slug) => {
      assertAllowed([slug]);
      return ctx.deletePage!(slug);
    }),
    updatePage: ctx.updatePage && (async (input) => {
      assertAllowed([input.slug]);
      return ctx.updatePage!(input);
    }),
    patchPage: ctx.patchPage && (async (input) => {
      assertAllowed([input.slug]);
      return ctx.patchPage!(input);
    }),
    metadataPatch: ctx.metadataPatch && (async (input) => {
      assertAllowed([input.slug]);
      return ctx.metadataPatch!(input);
    }),
    linkEnsure: ctx.linkEnsure && (async (input) => {
      assertAllowed([input.sourceSlug]);
      return ctx.linkEnsure!(input);
    }),
  };
}

function extractPageSlugs(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const value = input as Record<string, unknown>;
  const keys = toolName === 'wiki.merge'
    ? ['targetSlug', 'sourceSlug']
    : toolName === 'wiki.link.ensure'
      ? ['sourceSlug']
      : toolName === 'wiki.metadata.patch'
        ? ['slug']
        : ['slug', 'sourceSlug', 'targetSlug', 'pageSlug'];
  return [...new Set(keys.map((key) => value[key]).filter((slug): slug is string => typeof slug === 'string'))];
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
