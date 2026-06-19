import type { AgentContext, SkillTemplate } from '../types';
import { runAgentLoop, type AgentRunResult } from './agent-loop';

export type PipelineStep =
  | { kind: 'sequence'; skillId: string; carryThrough?: string[]; omitFromInput?: string[] }
  | { kind: 'fanout'; skillId: string; fromOutput: string }
  | { kind: 'map'; skillId: string; fromOutput: string; intoOutput: string };

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
      const input = step.omitFromInput && isPlainObject(carry)
        ? omitKeys(carry, step.omitFromInput)
        : carry;
      const r = await runAgentLoop({ skill, ctx: opts.ctx, input });
      carry = step.carryThrough && isPlainObject(carry) && isPlainObject(r.output)
        ? { ...pickKeys(carry, step.carryThrough), ...r.output }
        : r.output;
    } else if (step.kind === 'map') {
      const skill = opts.resolveSkill(step.skillId);
      const items = readPath(carry, step.fromOutput);
      if (!Array.isArray(items)) {
        throw new Error(`Map source at "${step.fromOutput}" is not an array (got ${typeof items})`);
      }
      const limit = opts.ctx.budgetSnapshot.maxParallelSubAgents;
      const results = await runWithSemaphore(items, limit, async (item) => {
        if (!isPlainObject(item) || typeof item.key !== 'string') {
          opts.ctx.emit('ingest:warn', 'Map item missing string key — skipping summarizer', { item });
          return item;
        }
        const stored = opts.ctx.chunkStore.get(item.key);
        if (!stored) {
          opts.ctx.emit('ingest:warn', `Chunk not found in chunkStore: ${item.key}`, { key: item.key });
          return item;
        }
        // map 纯收集（summarizer 无 overlay 副作用），无需像 fanout 那样做 overlay snapshot 隔离
        const childCtx: AgentContext = { ...opts.ctx, parentRunId: opts.ctx.rootRunId };
        const languageDirective = isPlainObject(carry) ? carry.languageDirective : undefined;
        // 只注入本块全文：整份 outline 一行/块，若按块广播即 O(N²) token（书本级会爆预算）。
        // summarizer 仅就本块定位即可；全局结构由 planner 汇总所有摘要时形成（outline 仍单次给 planner）。
        const r = await runAgentLoop({
          skill,
          ctx: childCtx,
          input: { sourceId: stored.sourceId, id: stored.id, heading: stored.heading, text: stored.text, languageDirective },
        });
        const out = r.output as { summary?: string } | undefined;
        if (typeof out?.summary !== 'string') {
          opts.ctx.emit('ingest:warn', `Summarizer returned no summary for chunk: ${item.key}`, { key: item.key, skillId: skill.id });
          return item;
        }
        return { ...item, content: out.summary };
      });
      // intoOutput 只写顶层 key（点路径会被当作字面量键创建；当前用法仅顶层）
      carry = isPlainObject(carry)
        ? { ...carry, [step.intoOutput]: results }
        : { [step.intoOutput]: results };
    } else {
      // fanout 分支：overlay 快照隔离、WriterConflictError 检测、putEntries 合并
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
        return runAgentLoop({ skill, ctx: childCtx, input: buildFanoutInput(carry, item, opts.ctx) });
      });
      // 冲突检测
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
      // 把每个 writer 的 entry 合并到父 overlay
      for (const r of results) {
        const out = r.output as { entry?: { action: 'create' | 'update' | 'delete'; path: string; content: string } } | undefined;
        if (out?.entry) opts.ctx.overlay.putEntries([out.entry]);
      }
      carry = isPlainObject(carry)
        ? { ...carry, writerOutputs: merged }
        : { writerOutputs: merged };
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

function buildFanoutInput(carry: unknown, item: unknown, ctx: AgentContext): unknown {
  if (!isPlainObject(carry) || !isPlainObject(item)) return item;

  const relevantChunks = resolveRelevantChunks(item, ctx);
  if (relevantChunks.length === 0) {
    ctx.emit('ingest:warn', `Writer for "${String(item.slug ?? item.path ?? '?')}" received zero relevant chunks`, {
      slug: item.slug ?? null,
    });
  }

  // 共享字段在前、per-page 字段在后：序列化后各 writer 输入有字节一致的前缀，
  // 供 DeepSeek 自动前缀缓存（命中要求从第 0 token 起完全一致）复用 plan/existingPages；
  // item / relevantChunks 为 per-page 内容，排在可变后缀（缓存 miss）。语义不变（字段按名读取）。
  return {
    subjectSlug: carry.subjectSlug,
    existingPages: carry.existingPages,
    plan: carry.plan,
    languageDirective: carry.languageDirective,
    ...item,
    relevantChunks,
  };
}

/** 按 planner 标注的 sourceRefs 从 chunkStore 解析出相关块全文；缺失块跳过并告警。 */
function resolveRelevantChunks(
  item: Record<string, unknown>,
  ctx: AgentContext,
): Array<{ id: string; heading: string; text: string }> {
  const refs = item.sourceRefs;
  if (!Array.isArray(refs)) return [];
  const out: Array<{ id: string; heading: string; text: string }> = [];
  for (const ref of refs) {
    if (!isPlainObject(ref) || typeof ref.sourceId !== 'string' || !Array.isArray(ref.chunkIds)) continue;
    for (const chunkId of ref.chunkIds) {
      if (typeof chunkId !== 'string') continue;
      const stored = ctx.chunkStore.get(`${ref.sourceId}:${chunkId}`);
      if (!stored) {
        ctx.emit('ingest:warn', `Planner referenced missing chunk: ${ref.sourceId}:${chunkId}`, {
          sourceId: ref.sourceId,
          chunkId,
        });
        continue;
      }
      out.push({ id: stored.id, heading: stored.heading, text: stored.text });
    }
  }
  return out;
}

function pickKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}

function omitKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function runWithSemaphore<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  let failed = false; // 任一实例失败后不再派发新实例（已在飞的自然结束）
  async function worker() {
    while (true) {
      if (failed) return;
      const idx = i++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
