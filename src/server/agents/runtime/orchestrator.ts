import type { AgentContext, SkillTemplate } from '../types';
import { runAgentLoop, AgentCancelled, type AgentRunResult } from './agent-loop';
import { BudgetExceededError } from './budget';
import type { ChangesetEntry } from '@/lib/contracts';

export type PipelineStep =
  | { kind: 'sequence'; skillId: string; carryThrough?: string[]; omitFromInput?: string[]; checkpointAs?: 'plan' }
  | { kind: 'fanout'; skillId: string; fromOutput: string; checkpointAs?: 'writer-page' }
  | { kind: 'map'; skillId: string; fromOutput: string; intoOutput: string; checkpointAs?: 'chunk-summary' };

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
      // 断点续传：planner 已缓存则跳过 LLM，用缓存 plan 当作步骤输出
      const cachedPlan = step.checkpointAs === 'plan' ? opts.ctx.checkpoint?.getPlan() : undefined;
      let r: AgentRunResult;
      if (cachedPlan !== undefined && cachedPlan !== null) {
        r = { runId: 'cached-plan', output: cachedPlan, tokensUsed: 0, stepCount: 0, cacheHitTokens: 0 };
      } else {
        r = await runAgentLoop({ skill, ctx: opts.ctx, input });
        if (step.checkpointAs === 'plan') opts.ctx.checkpoint?.putPlan(r.output);
      }
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
        // 断点续传：命中已缓存摘要则跳过 summarizer（书本级 map 步是 N 次 LLM 调用）
        if (step.checkpointAs === 'chunk-summary') {
          const cached = opts.ctx.checkpoint?.getChunkSummary(item.key);
          if (typeof cached === 'string') return { ...item, content: cached };
        }
        // map 纯收集（summarizer 无 overlay 副作用），无需像 fanout 那样做 overlay snapshot 隔离
        const childCtx: AgentContext = { ...opts.ctx, parentRunId: opts.ctx.rootRunId };
        const languageDirective = isPlainObject(carry) ? carry.languageDirective : undefined;
        // 只注入本块全文：整份 outline 一行/块，若按块广播即 O(N²) token（书本级会爆预算）。
        // summarizer 仅就本块定位即可；全局结构由 planner 汇总所有摘要时形成（outline 仍单次给 planner）。
        let r: AgentRunResult;
        try {
          r = await runAgentLoop({
            skill,
            ctx: childCtx,
            input: { sourceId: stored.sourceId, id: stored.id, heading: stored.heading, text: stored.text, languageDirective },
          });
        } catch (err) {
          // map 逐块独立：单块摘要失败（如 provider 返回无法解析的输出）降级为空摘要，
          // 不拖垮整本书的 ingest——writer 取的是 chunkStore 全文，不依赖摘要。
          // BudgetExceeded / Cancelled 是控制流异常，必须照常上抛中断全程。
          if (err instanceof BudgetExceededError || err instanceof AgentCancelled) throw err;
          opts.ctx.emit('ingest:warn', `Summarizer failed for chunk ${item.key}; using empty summary`, {
            key: item.key,
            skillId: skill.id,
            error: (err as Error).message,
          });
          return item;
        }
        const out = r.output as { summary?: string } | undefined;
        if (typeof out?.summary !== 'string') {
          opts.ctx.emit('ingest:warn', `Summarizer returned no summary for chunk: ${item.key}`, { key: item.key, skillId: skill.id });
          return item;
        }
        if (step.checkpointAs === 'chunk-summary') opts.ctx.checkpoint?.putChunkSummary(item.key, out.summary);
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
        const slug = isPlainObject(item) && typeof item.slug === 'string' ? item.slug : undefined;
        // 断点续传：命中已写页则跳过 writer LLM（fanout 是书本级最贵步骤）
        if (step.checkpointAs === 'writer-page' && slug) {
          const cached = opts.ctx.checkpoint?.getWriterPage(slug);
          if (cached) {
            return { runId: 'cached-writer', output: cached, tokensUsed: 0, stepCount: 0, cacheHitTokens: 0 } as AgentRunResult;
          }
        }
        const childCtx: AgentContext = {
          ...opts.ctx,
          overlay: baseOverlay.snapshot(),
          parentRunId: opts.ctx.rootRunId,
        };
        const r = await runAgentLoop({ skill, ctx: childCtx, input: buildFanoutInput(carry, item, opts.ctx) });
        // 每页完成瞬间即落盘（barrier 之前）——fail-fast 中止时已完成 + 在飞页都保住
        if (step.checkpointAs === 'writer-page' && slug) {
          const entry = r.output as ChangesetEntry | undefined;
          if (entry?.path) opts.ctx.checkpoint?.putWriterPage(slug, entry);
        }
        return r;
      });
      // 冲突检测：writer 直接产出单个 changeset entry（ingest-writer v3 起无 `entry` 包装——
      // 单键包装会被 DeepSeek 等拍平致结构化输出失败，故 schema 扁平化）。
      const seenSlugs = new Set<string>();
      const merged: unknown[] = [];
      for (const r of results) {
        const path = (r.output as { path?: string } | undefined)?.path;
        if (path) {
          if (seenSlugs.has(path)) {
            throw new WriterConflictError(path);
          }
          seenSlugs.add(path);
        }
        merged.push(r.output);
      }
      // 每个 writer 的 entry 既并入父 overlay（供后续 read 隔离），也暂存进 pending——
      // commit_changeset 直接提交 pending，reviewer 不必逐字重发未改动页（消除巨量工具参数）。
      for (const r of results) {
        const entry = r.output as { action: 'create' | 'update' | 'delete'; path: string; content: string } | undefined;
        if (entry?.path) {
          opts.ctx.overlay.putEntries([entry]);
          opts.ctx.pending.entries.push(entry);
        }
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
