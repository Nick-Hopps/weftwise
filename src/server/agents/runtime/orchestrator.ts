import type { AgentContext, SkillTemplate } from '../types';
import { runAgentLoop, type AgentRunResult } from './agent-loop';

export type PipelineStep =
  | { kind: 'sequence'; skillId: string }
  | { kind: 'fanout'; skillId: string; fromOutput: string };

export class WriterConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`Multiple writers produced an entry for slug: ${slug}`);
    this.name = 'WriterConflictError';
  }
}

export async function runSingle(opts: {
  skill: SkillTemplate;
  ctx: AgentContext;
  input: unknown;
}): Promise<AgentRunResult> {
  return runAgentLoop(opts);
}

export async function runPipeline(opts: {
  steps: PipelineStep[];
  resolveSkill: (id: string) => SkillTemplate;
  ctx: AgentContext;
  initialInput: unknown;
}): Promise<unknown> {
  let carry: unknown = opts.initialInput;
  for (const step of opts.steps) {
    if (step.kind === 'sequence') {
      const skill = opts.resolveSkill(step.skillId);
      const r = await runAgentLoop({ skill, ctx: opts.ctx, input: carry });
      carry = r.output;
    } else {
      const skill = opts.resolveSkill(step.skillId);
      const items = readPath(carry, step.fromOutput);
      if (!Array.isArray(items)) {
        throw new Error(`Fanout source at "${step.fromOutput}" is not an array (got ${typeof items})`);
      }
      const baseOverlay = opts.ctx.overlay.snapshot();
      const limit = opts.ctx.budgetSnapshot.maxParallelSubAgents;
      const results = await runWithSemaphore(items, limit, async (item) => {
        const childCtx: AgentContext = {
          ...opts.ctx,
          overlay: baseOverlay.snapshot(),
          parentRunId: opts.ctx.rootRunId,
        };
        return runAgentLoop({ skill, ctx: childCtx, input: buildFanoutInput(carry, item) });
      });
      // Merge writer outputs (each is an object; assume each yields a top-level `entry` field).
      const seenSlugs = new Set<string>();
      const merged: unknown[] = [];
      for (const r of results) {
        const out = r.output as { entry?: { path?: string } } | undefined;
        const path = out?.entry?.path;
        if (path) {
          if (seenSlugs.has(path)) {
            throw new WriterConflictError(path);
          }
          seenSlugs.add(path);
        }
        merged.push(r.output);
      }
      // Apply each writer's `entry` to the parent overlay.
      for (const r of results) {
        const out = r.output as { entry?: { action: 'create' | 'update' | 'delete'; path: string; content: string } } | undefined;
        if (out?.entry) opts.ctx.overlay.putEntries([out.entry]);
      }
      carry = { ...((carry as object) ?? {}), writerOutputs: merged };
    }
  }
  return carry;
}

function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function buildFanoutInput(carry: unknown, item: unknown): unknown {
  if (!isPlainObject(carry) || !isPlainObject(item)) return item;

  return {
    ...item,
    sources: carry.sources,
    subjectSlug: carry.subjectSlug,
    existingPages: carry.existingPages,
    plan: carry.plan,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function runWithSemaphore<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
