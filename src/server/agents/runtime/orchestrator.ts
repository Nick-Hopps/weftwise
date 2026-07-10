import type { AgentContext, SkillTemplate } from '../types';
import { runAgentLoop, AgentCancelled, type AgentRunResult } from './agent-loop';
import { runPageVerification } from './verify-page';
import { runPageSupplement } from './supplement-page';
import { reconcileMergeUpdateFidelity } from './merge-update-fidelity';
import { BudgetExceededError } from './budget';
import { extractWikiLinks } from '@/server/wiki/wikilinks';
import type { ChangesetEntry } from '@/lib/contracts';

/** T2.2：fanout 每页 existingPages 检索式子集的 top-K 常量（可调）。 */
export const EXISTING_PAGES_FANOUT_TOP_K = 20;

export type PipelineStep =
  | { kind: 'sequence'; skillId: string; carryThrough?: string[]; omitFromInput?: string[]; checkpointAs?: 'plan' }
  | { kind: 'fanout'; skillId: string; fromOutput: string; checkpointAs?: 'writer-page' | 'enricher-page' | 'verifier-page'; injectPriorPageAs?: string; injectExistingPageForUpdate?: boolean }
  | { kind: 'supplement'; skillId: string; fromOutput: string; checkpointAs?: 'supplement-page'; injectPriorPageAs?: string }
  | { kind: 'verify'; fromOutput: string; checkpointAs?: 'verifier-page'; injectPriorPageAs?: string }
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
    } else if (step.kind === 'fanout' || step.kind === 'verify' || step.kind === 'supplement') {
      // fanout / verify / supplement 分支：overlay 快照隔离、WriterConflictError 检测、putEntries 合并。
      // verify / supplement 与 fanout 共用全部骨架，仅「每项的计算」不同（verify 跑两段式核查、supplement 跑护栏化正文补全，而非单 skill）。
      const skill = step.kind === 'fanout' || step.kind === 'supplement' ? opts.resolveSkill(step.skillId) : undefined;
      const items = readPath(carry, step.fromOutput);
      if (!Array.isArray(items)) {
        throw new Error(`Fanout source at "${step.fromOutput}" is not an array (got ${typeof items})`);
      }
      const baseOverlay = opts.ctx.overlay.snapshot();
      const limit = opts.ctx.budgetSnapshot.maxParallelSubAgents;
      // T1.5：并发 fanout 的每一项都要在启动前预扣 token 额度，否则所有并发实例会在任何一页
      // 记账前就都通过 assertWithin 闸门，并行度直接击穿 maxTokensPerJob。估算优先复用调用方
      // （ingest-service）注入的 ingest-prep 估算；未注入时按 maxTokensPerJob 均分估算，
      // 保证 re-enrich 等非 ingest 场景也不会跳过预扣。
      const perItemReserve = opts.ctx.estimateFanoutReserve
        ? opts.ctx.estimateFanoutReserve(items.length)
        : Math.max(1, Math.ceil(opts.ctx.budgetSnapshot.maxTokensPerJob / Math.max(1, items.length)));
      // T1.6：冲突检测提前到 checkpoint.put 之前——用同一张 claimedPaths 表在「读缓存」与「写缓存」
      // 两处都做同 path 认领，检测到冲突时丢弃后到者的检查点条目（不写入/主动删除），
      // 避免坏页进检查点后 resume 按 slug 命中缓存、原样复现冲突、死循环重试。
      // 所有认领操作都在 async 函数体内同步完成（无 await 穿插），单线程事件循环下不存在竞态。
      const claimedPaths = new Map<string, string>();
      const results = await runWithSemaphore(items, limit, async (item) => {
        const slug = isPlainObject(item) && typeof item.slug === 'string' ? item.slug : undefined;
        // 断点续传：命中已写页则跳过 LLM（fanout 是书本级最贵步骤）——不产生调用，不预扣。
        if (step.checkpointAs && slug) {
          const cached = readStageCheckpoint(opts.ctx.checkpoint, step.checkpointAs, slug);
          if (cached) {
            const cachedPath = cached.path;
            if (cachedPath && claimedPaths.has(cachedPath)) {
              // resume 防御：检查点中残留的同 path 冲突条目（如旧版本未做该检测时写入的）。
              // 丢弃后到者的缓存条目并重新生成，而不是原样复现冲突。
              const winnerSlug = claimedPaths.get(cachedPath);
              opts.ctx.emit('ingest:warn', `Checkpoint conflict on resume: "${slug}" and "${winnerSlug}" both cached path "${cachedPath}" — discarding "${slug}"'s checkpoint and regenerating`, {
                slug, winnerSlug, path: cachedPath,
              });
              opts.ctx.checkpoint?.deleteStagePage(step.checkpointAs, slug);
              // 不 return：继续走下方正常生成路径
            } else {
              if (cachedPath) claimedPaths.set(cachedPath, slug);
              return { runId: 'cached-page', output: cached, tokensUsed: 0, stepCount: 0, cacheHitTokens: 0 } as AgentRunResult;
            }
          }
        }
        const reservation = await opts.ctx.budget.reserve(perItemReserve);
        let r: AgentRunResult;
        try {
          const childCtx: AgentContext = {
            ...opts.ctx,
            overlay: baseOverlay.snapshot(),
            parentRunId: opts.ctx.rootRunId,
          };
          const input = await buildFanoutInput(carry, item, opts.ctx, step);
          if (step.kind === 'verify') {
            r = await runPageVerification({ resolveSkill: opts.resolveSkill, ctx: childCtx, input });
          } else if (step.kind === 'supplement') {
            r = await runPageSupplement({ skill: skill!, ctx: childCtx, input });
          } else {
            r = await runAgentLoop({ skill: skill!, ctx: childCtx, input });
            // 增量合并保真护栏：仅本页命中 existingPages（update 语义，buildFanoutInput 已注入
            // existingPageContent）时校验——create 语义的新页没有"现有正文"可比较，不适用。
            if (
              step.injectExistingPageForUpdate &&
              isPlainObject(input) &&
              typeof input.existingPageContent === 'string'
            ) {
              r = await reconcileMergeUpdateFidelity({
                existingContent: input.existingPageContent,
                first: r,
                rerun: (extra) => runAgentLoop({ skill: skill!, ctx: childCtx, input: { ...input, ...extra } }),
                emit: opts.ctx.emit,
                slug,
              });
            }
          }
        } finally {
          // 成功或失败都必须结算释放预留——否则失败页会永久占着额度饿死排队中的其他页。
          opts.ctx.budget.settle(reservation, 0);
        }
        // 路径强制规范：fanout over plan.pages 时 orchestrator 已知 slug+subjectSlug，
        // 不信任模型自填的 path——实测 verifier 等会吐裸 slug（如 "quicksort" 而非
        // "wiki/general/quicksort.md"），导致落到 vault 根、indexer 解析不出 slug 而漏建索引。
        if (slug && isPlainObject(carry) && typeof carry.subjectSlug === 'string') {
          const entry = r.output as { path?: string } | undefined;
          if (entry && typeof entry.path === 'string') {
            entry.path = `wiki/${carry.subjectSlug}/${slug}.md`;
          }
        }
        // 每页完成瞬间即落盘（barrier 之前）——fail-fast 中止时已完成 + 在飞页都保住。
        // T1.6：落盘前先按 path 认领；撞见已认领的 path 时，判定为 WriterConflict——
        // 既不写入本页检查点，也把先前"认领者"已落盘的检查点一并撤销，防止任一方
        // 单独存活成为死循环续传的种子（真正的失败判定仍由下方 seenSlugs 统一抛出）。
        if (step.checkpointAs && slug) {
          const entry = r.output as ChangesetEntry | undefined;
          if (entry?.path) {
            if (claimedPaths.has(entry.path)) {
              const winnerSlug = claimedPaths.get(entry.path);
              if (winnerSlug) opts.ctx.checkpoint?.deleteStagePage(step.checkpointAs, winnerSlug);
            } else {
              claimedPaths.set(entry.path, slug);
              writeStageCheckpoint(opts.ctx.checkpoint, step.checkpointAs, slug, entry);
            }
          }
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
      // service finalize 会直接提交 pending，后续阶段不必逐字重发未改动页（消除巨量参数）。
      for (const r of results) {
        const entry = r.output as { action: 'create' | 'update' | 'delete'; path: string; content: string } | undefined;
        if (entry?.path) {
          opts.ctx.overlay.putEntries([entry]);
          upsertPending(opts.ctx.pending, entry);
        }
      }
      carry = isPlainObject(carry)
        ? { ...carry, writerOutputs: merged }
        : { writerOutputs: merged };
    }
  }
  return carry;
}

/** 暂存区按 path 覆盖（last-write-wins）：后阶段同 path 页替换前阶段，避免重复 entry。 */
function upsertPending(pending: { entries: ChangesetEntry[] }, entry: ChangesetEntry): void {
  const i = pending.entries.findIndex((e) => e.path === entry.path);
  if (i >= 0) pending.entries[i] = entry;
  else pending.entries.push(entry);
}

function readStageCheckpoint(ck: AgentContext['checkpoint'], kind: 'writer-page' | 'enricher-page' | 'verifier-page' | 'supplement-page', slug: string): ChangesetEntry | undefined {
  if (!ck) return undefined;
  if (kind === 'writer-page') return ck.getWriterPage(slug);
  if (kind === 'enricher-page') return ck.getEnricherPage(slug);
  if (kind === 'verifier-page') return ck.getVerifierPage(slug);
  if (kind === 'supplement-page') return ck.getSupplementPage(slug);
  return undefined;
}

function writeStageCheckpoint(ck: AgentContext['checkpoint'], kind: 'writer-page' | 'enricher-page' | 'verifier-page' | 'supplement-page', slug: string, entry: ChangesetEntry): void {
  if (!ck) return;
  if (kind === 'writer-page') ck.putWriterPage(slug, entry);
  else if (kind === 'enricher-page') ck.putEnricherPage(slug, entry);
  else if (kind === 'verifier-page') ck.putVerifierPage(slug, entry);
  else if (kind === 'supplement-page') ck.putSupplementPage(slug, entry);
}

function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export async function buildFanoutInput(
  carry: unknown,
  item: unknown,
  ctx: AgentContext,
  step: { injectPriorPageAs?: string; injectExistingPageForUpdate?: boolean },
): Promise<unknown> {
  if (!isPlainObject(carry) || !isPlainObject(item)) return item;

  const relevantChunks = resolveRelevantChunks(item, ctx);
  if (relevantChunks.length === 0) {
    ctx.emit('ingest:warn', `Writer for "${String(item.slug ?? item.path ?? '?')}" received zero relevant chunks`, {
      slug: item.slug ?? null,
    });
  }

  // 增益/核查阶段：把上一阶段该页产物的 content 按 path 先解出（existingPages 子集检索的
  // wikilink 提取需要用到这份草稿文本），再决定注入到哪个 key。
  let priorPageContent: string | undefined;
  if (step.injectPriorPageAs && typeof item.slug === 'string') {
    const path = `wiki/${String(carry.subjectSlug)}/${item.slug}.md`;
    const prior = Array.isArray(carry.writerOutputs)
      ? (carry.writerOutputs as Array<{ path?: string; content?: string }>).find((e) => e?.path === path)
      : undefined;
    if (prior?.content !== undefined) {
      priorPageContent = prior.content;
    } else {
      ctx.emit('ingest:warn', `Enrich/verify for "${item.slug}" found no prior-stage page at ${path}`, { slug: item.slug });
    }
  }

  // T2.2：existingPages 全量注入是 O(N·M) token 的元凶（N=现有页数，M=本次 fanout 页数）。
  // 改为每页只注入相关子集：检索 top-K ∪ wikilink 目标 ∪ 自身条目（update 语义）。
  // plan 内的兄弟页信息仍经上面 `plan: carry.plan` 整体透传，不受影响（不在此处重复）。
  const existingPagesSubset = await selectRelevantExistingPagesForFanout({
    ctx,
    item,
    existingPages: Array.isArray(carry.existingPages) ? (carry.existingPages as ExistingPageEntry[]) : [],
    priorContent: priorPageContent,
    subjectSlug: typeof carry.subjectSlug === 'string' ? carry.subjectSlug : undefined,
  });

  // 共享字段在前、per-page 字段在后：序列化后各 writer 输入有字节一致的前缀，
  // 供 DeepSeek 自动前缀缓存（命中要求从第 0 token 起完全一致）复用 plan；
  // existingPages 自 T2.2 起按页裁剪、不再跨页恒定，该字段的前缀缓存收益因此让位于 token 节省
  // （见 spec 陷阱提示：属预期代价）。item / relevantChunks 为 per-page 内容，排在可变后缀。
  const base: Record<string, unknown> = {
    subjectSlug: carry.subjectSlug,
    existingPages: existingPagesSubset,
    plan: carry.plan,
    languageDirective: carry.languageDirective,
    augmentationDirective: carry.augmentationDirective,
    profileHint: carry.profileHint,
    expositionDirective: carry.expositionDirective,
    ...item,
    relevantChunks,
  };

  if (step.injectPriorPageAs && priorPageContent !== undefined) {
    base[step.injectPriorPageAs] = priorPageContent;
  }
  // 增量合并：writer 阶段若本页 slug 命中 existingPages（=更新已有页），注入现有正文供 writer 并入。
  if (step.injectExistingPageForUpdate && typeof item.slug === 'string') {
    const existing = Array.isArray(carry.existingPages) ? carry.existingPages : [];
    const isUpdate = existing.some(
      (p) => isPlainObject(p) && (p as { slug?: unknown }).slug === item.slug,
    );
    if (isUpdate) {
      const page = await ctx.overlay.readPage(String(carry.subjectSlug), item.slug);
      if (page?.markdown) base.existingPageContent = page.markdown;
    }
  }
  return base;
}

interface ExistingPageEntry {
  slug: string;
  [key: string]: unknown;
}

/**
 * T2.2：从全量 existingPages 中为单个 fanout 项裁出相关子集。
 * 子集 = 检索 top-K ∩ existingPages  ∪  wikilink 目标 ∩ existingPages  ∪  自身条目（update 语义）。
 * 检索失败/未注入/零结果时优雅降级为「wikilink 目标 + 自身条目」的最小集合，绝不抛错致 fanout 失败。
 */
export async function selectRelevantExistingPagesForFanout(params: {
  ctx: AgentContext;
  item: Record<string, unknown>;
  existingPages: ExistingPageEntry[];
  priorContent?: string;
  /** 本 subject 的 slug；wikilink 目标须属于本 subject 才纳入（existingPages 全是本 subject 的页）。 */
  subjectSlug?: string;
  topK?: number;
}): Promise<ExistingPageEntry[]> {
  const { ctx, item, existingPages, priorContent, subjectSlug, topK = EXISTING_PAGES_FANOUT_TOP_K } = params;
  if (existingPages.length === 0) return existingPages;

  const bySlug = new Map(existingPages.map((p) => [p.slug, p]));
  const selectedSlugs = new Set<string>();
  const selfSlug = typeof item.slug === 'string' ? item.slug : undefined;

  // 自身条目：本页若命中 existingPages（=update 语义），必须在子集中——writer/enricher/verify
  // 都靠 existingPages.some(slug===item.slug) 判定 update/create（见 injectExistingPageForUpdate
  // 及 verify-page/supplement-page 的 exists 判定）。
  if (selfSlug && bySlug.has(selfSlug)) selectedSlugs.add(selfSlug);

  // wikilink 目标：本页 plan 条目可用文本（title/summary）+ 上一阶段草稿（enricher/verify 场景）
  // 中出现的 [[...]] 目标，只要命中 existingPages 就必须在子集里，供模型核对链接。
  const textForLinks = [
    typeof item.title === 'string' ? item.title : '',
    typeof item.summary === 'string' ? item.summary : '',
    priorContent ?? '',
  ].join('\n');
  if (textForLinks.trim()) {
    // currentSubjectSlug 让无前缀链接解析为本 subject；显式 [[other-subject:foo]] 的
    // targetSubjectSlug 会是别的 subject——即使本 subject 恰有同名 slug 也不得纳入
    // （existingPages 全是本 subject 的页，跨主题引用不在其核对范围内）。
    const currentSubjectSlug = subjectSlug ?? '';
    for (const link of extractWikiLinks(textForLinks, { currentSubjectSlug })) {
      if (link.targetSubjectSlug !== currentSubjectSlug) continue;
      if (bySlug.has(link.target)) selectedSlugs.add(link.target);
    }
  }

  // 检索 top-K：优先复用 ctx.retrieveRelevantPages（ingest-service 注入 hybridRankSlugs）。
  // 未注入 / 抛错 / 零结果时静默跳过——上面已收集的自身条目 + wikilink 目标即为最小降级集合。
  if (ctx.retrieveRelevantPages) {
    const query = [
      typeof item.title === 'string' ? item.title : '',
      typeof item.summary === 'string' ? item.summary : '',
    ].filter(Boolean).join(' — ') || selfSlug;
    if (query) {
      try {
        const subjectId = ctx.subject?.id;
        if (subjectId) {
          const ranked = await ctx.retrieveRelevantPages(subjectId, query, topK);
          for (const slug of ranked) {
            if (bySlug.has(slug)) selectedSlugs.add(slug);
          }
        }
      } catch (err) {
        ctx.emit('ingest:warn', `existingPages retrieval failed for "${selfSlug ?? '?'}" — falling back to minimal set`, {
          slug: selfSlug ?? null,
          error: (err as Error).message,
        });
        // 不上抛：selectedSlugs 已有的自身条目 + wikilink 目标原样返回，fanout 继续。
      }
    }
  }

  return existingPages.filter((p) => selectedSlugs.has(p.slug));
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
