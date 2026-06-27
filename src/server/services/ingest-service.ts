// src/server/services/ingest-service.ts
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { parseSourceAsync, requiresBuffer } from '../sources/parser-registry';
import { getRawSourceContent, getRawSourceBuffer, updateSourceChunks, saveRawSource } from '../sources/source-store';
import {
  getAgentMaxSteps,
  getAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
  getWikiLanguage,
  getAgentAutoCurate,
} from '../db/repos/settings-repo';
import * as queue from '../jobs/queue';
import { renderLanguageDirective, renderAugmentationDirective, renderExpositionDirective } from '../llm/prompts/prompt-context';
import { runPipeline, runSingle, type PipelineStep } from '../agents/runtime/orchestrator';
import { createBudgetTracker } from '../agents/runtime/budget';
import { createOverlayVault } from '../agents/runtime/overlay-vault';
import { loadCheckpoint } from '../agents/runtime/checkpoint';
import { commitPending } from '../agents/tools/builtin/commit-changeset';
import { buildWikiPath } from '../wiki/page-identity';
import {
  prepareIngest,
  fillInlineContent,
  isInlinePath,
  estimateIngestCost,
  reduceCostForResume,
} from './ingest-prep';
import { getRuntimeRegistries } from '../worker-runtime';
import { enqueueEmbedIndex } from './embedding-service';
import { createHash, randomUUID } from 'node:crypto';
import { extractContent } from '../search/web-search';
import type { AgentContext, CitedSource } from '../agents/types';
import type { AugmentationLevel, ChangesetEntry, IngestResult, Job } from '@/lib/contracts';

// 当前单源；prepareIngest 已接受数组，未来多源批量在此扩展
interface IngestParams {
  sourceId: string;
  filename: string;
  subjectId: string;
}

async function loadCleanText(filename: string, subjectSlug: string): Promise<string> {
  let textContent: string;
  let bufferContent: Buffer | null = null;
  if (requiresBuffer(filename)) {
    bufferContent = getRawSourceBuffer(subjectSlug, filename);
    if (!bufferContent) {
      throw new Error(`Source file not found: ${filename}`);
    }
    textContent = '';
  } else {
    const raw = getRawSourceContent(subjectSlug, filename);
    if (!raw) {
      throw new Error(`Source file not found: ${filename}`);
    }
    textContent = raw;
  }
  const parsed = await parseSourceAsync(filename, textContent, bufferContent);
  return parsed.cleanText;
}

/**
 * 构造 ingest 流水线 steps。`level === 'off'` 时跳过 enricher + verify（退回纯忠实层）。
 * 抽为纯函数以便单测；handler 把 inline/level/carryKeys 传入。
 */
export function buildIngestSteps(opts: {
  inline: boolean;
  level: AugmentationLevel;
  carryKeys: string[];
}): PipelineStep[] {
  const { inline, level, carryKeys } = opts;
  const augmentSteps: PipelineStep[] =
    level === 'off'
      ? []
      : [
          { kind: 'fanout', skillId: 'ingest-enricher', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'enricher-page' },
          { kind: 'verify', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
        ];
  return [
    ...(inline
      ? []
      : [{ kind: 'map', skillId: 'ingest-chunk-summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs', checkpointAs: 'chunk-summary' } as PipelineStep]),
    { kind: 'sequence', skillId: 'ingest-planner', carryThrough: carryKeys, checkpointAs: 'plan' },
    { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page', injectExistingPageForUpdate: true },
    ...augmentSteps,
  ];
}

registerHandler('ingest', async (job: Job, emit): Promise<Record<string, unknown>> => {
  const params = JSON.parse(job.paramsJson) as Partial<IngestParams>;
  const { sourceId, filename, subjectId } = params;
  if (!sourceId || !filename) throw new Error('Ingest job missing sourceId or filename');
  if (!subjectId) throw new Error('Ingest job missing subjectId — re-queue with a subject');

  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  emit('ingest:start', `Ingest started for subject ${subject.slug}`, { subject: subject.slug, filename });

  emit('ingest:parsing', `Parsing source: ${filename}`);
  const cleanText = await loadCleanText(filename, subject.slug);

  // 解析期确定性准备：预清洗 → 切块（零 token）
  const prep = prepareIngest([{ sourceId, filename, cleanText }]);
  updateSourceChunks(sourceId, prep.chunksBySource[sourceId] ?? []);

  const budgetSnapshot = {
    maxSteps: getAgentMaxSteps(),
    maxTokensPerJob: getAgentMaxTokensPerJob(),
    maxParallelSubAgents: getAgentMaxParallelSubAgents(),
  };

  // 断点续传：载入该 job 已有检查点（重试 = requeue 同一 job.id）
  const checkpoint = loadCheckpoint(job.id);
  const resumeProgress = checkpoint.hasAny() ? checkpoint.progress() : null;
  if (resumeProgress) {
    emit(
      'ingest:resuming',
      `Resuming ingest: plan ${resumeProgress.plan ? 'cached' : 'pending'}, ${resumeProgress.chunkSummaries} summaries, ${resumeProgress.writerPages}${resumeProgress.totalPages ? `/${resumeProgress.totalPages}` : ''} pages done`,
      { progress: resumeProgress },
    );
  }

  // 预算预检（spec E.2）：任何 LLM 调用前 fail-fast；恢复态按已完成产物折减估算
  const inline = isInlinePath(prep.totalTokens);
  const fullEstimate = estimateIngestCost(prep.totalTokens, prep.chunkCount, inline);
  const estimatedCost = resumeProgress ? reduceCostForResume(fullEstimate, resumeProgress) : fullEstimate;
  emit('ingest:chunking', `Chunked into ${prep.chunkCount} chunks (~${prep.totalTokens} tokens)`, {
    chunkCount: prep.chunkCount,
    totalTokens: prep.totalTokens,
    estimatedCost,
  });
  if (estimatedCost > budgetSnapshot.maxTokensPerJob) {
    throw new Error(
      `Estimated cost ~${estimatedCost} tokens exceeds budget agentMaxTokensPerJob=${budgetSnapshot.maxTokensPerJob}; ` +
      `raise it to >= ${Math.ceil(estimatedCost * 1.1)} in Settings and retry`,
    );
  }

  const { skillRegistry, toolRegistry } = getRuntimeRegistries();

  // Skill 契约版本守卫：planner v2 起产 sourceRefs / writer 收 relevantChunks；
  // writer v3 起 outputSchema 扁平化（去掉 entry 包装——单键包装会被 DeepSeek 等拍平致
  // 结构化输出失败），与 orchestrator 扁平消费强绑定。
  // writer v6 起：复述者→讲解者契约 + 新增 expositionDirective 输入。
  // 播种不覆盖已存在文件，存量 vault 的旧 skill 会静默产零素材/丢页，必须拦截。
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-planner': 2, 'ingest-writer': 6, 'ingest-indexer': 1,
    'ingest-enricher': 4, 'ingest-verifier': 2,
    'ingest-verifier-triage': 2, 'ingest-verifier-apply': 3,
  };
  for (const [skillId, minVersion] of Object.entries(MIN_SKILL_VERSIONS)) {
    const s = skillRegistry.get(skillId);
    if (!s) throw new Error(`Skill not loaded: ${skillId}`);
    if (s.version < minVersion) {
      throw new Error(
        `Skill "${skillId}" is v${s.version} but this pipeline requires v${minVersion}+. ` +
        `Your vault has an outdated copy: delete vault/.llm-wiki/skills/${skillId}.md (or merge the new template from examples/skills/) and restart the worker to re-seed.`,
      );
    }
  }

  const budget = createBudgetTracker(budgetSnapshot);
  const overlay = createOverlayVault({ subjectSlug: subject.slug });

  const ctx: AgentContext = {
    job,
    subject,
    emit,
    budget,
    overlay,
    toolRegistry,
    skillRegistry,
    rootRunId: randomUUID(),
    parentRunId: null,
    cancelled: () => false,
    committed: { value: false },
    pending: { entries: [] },
    chunkStore: prep.chunkStore,
    budgetSnapshot,
    checkpoint,
    citedSources: new Map(),
  };

  // ⑨ 续传补源：从 checkpoint rehydrate 已核查页累积的网页引用源。新 run 为空 no-op；
  // 续传时这些页会命中 verifier-page 检查点而跳过 verify-page（不再 record），靠此补回，
  // 使 finalize 仍把崩溃前已核查页的网页导入为 source（闭合 I-1）。
  for (const c of checkpoint.getCitedSources()) ctx.citedSources!.set(c.url, c);

  const existingPages = pagesRepo
    .getAllPages(subjectId)
    .map((p) => ({ slug: p.slug, title: p.title, summary: p.summary }));

  const languageDirective = renderLanguageDirective(getWikiLanguage());

  const augmentationLevel = subject.augmentationLevel;
  const augmentationDirective =
    augmentationLevel === 'off' ? '' : renderAugmentationDirective(augmentationLevel);
  const expositionDirective = renderExpositionDirective(augmentationLevel);

  // carry 透传 key：让 planner 输出后 fanout/reviewer 仍能读到上下文（planner outputSchema 只有 plan）
  const carryKeys = ['chunkRefs', 'sources', 'subjectSlug', 'existingPages', 'outline', 'languageDirective', 'augmentationDirective', 'expositionDirective'];
  const steps = buildIngestSteps({ inline, level: augmentationLevel, carryKeys });

  emit('ingest:planning', `Planning source: ${filename}`, { path: inline ? 'inline' : 'map-reduce' });

  // 内容阶段（planner → writer → enricher → verifier）把每页暂存进 ctx.pending；
  // runPipeline 返回末阶段 carry（含 plan/sources/languageDirective），不在 agent 内提交。
  const carry = await runPipeline({
    steps,
    resolveSkill: (id) => {
      const s = skillRegistry.get(id);
      if (!s) throw new Error(`Skill not loaded: ${id}`);
      return s;
    },
    ctx,
    initialInput: {
      chunkRefs: inline ? fillInlineContent(prep.chunkRefs, prep.chunkStore) : prep.chunkRefs,
      sources: [{ sourceId, filename }],
      subjectSlug: subject.slug,
      existingPages,
      outline: prep.outline,
      languageDirective,
      augmentationDirective,
      expositionDirective,
    },
  }) as {
    plan?: { pages?: Array<{ slug: string; title: string; summary?: string }> };
    sources?: Array<{ sourceId: string; filename: string }>;
  };

  // finalize：无-tools 的 ingest-indexer（结构化输出，不可能进工具循环）产出 index.md / log.md，
  // 然后 commitPending 把 ctx.pending（全部内容页）∪ index/log 一次性原子提交。
  // 旧的 tool-using reviewer 阶段（在 packyapi openai-compatible 上工具死循环）已删除。
  const result = await finalizeIngest(ctx, {
    // 索引须覆盖全 subject：现有页 ∪ 本次 plan 页（按 slug 去重，plan 覆盖；排除 index/log meta 页）。
    pages: mergePagesForIndex(existingPages, carry.plan?.pages ?? []),
    sources: carry.sources ?? [{ sourceId, filename }],
    languageDirective,
  });

  // 成功（已 commit）→ 清除检查点；失败时不清，留给下次重试
  checkpoint.clear();

  // 写后触发向量回填（未配置 embedding 时 no-op）
  enqueueEmbedIndex(subject.id);

  // 自动策展：ingest 已提交成功 → 对本次受影响页（+ 邻居）做一次保守策展（受全局开关控制）。
  // fire-and-forget 入队，不影响本次 ingest 的成功返回。
  if (getAgentAutoCurate()) {
    const touchedSlugs = [...result.pagesCreated, ...result.pagesUpdated].filter(
      (s) => s !== 'index' && s !== 'log',
    );
    if (touchedSlugs.length > 0) {
      try {
        queue.enqueue('curate', { scope: 'pages', slugs: touchedSlugs, subjectId: subject.id }, subject.id);
        emit('ingest:complete', `Queued auto-curation for ${touchedSlugs.length} touched page(s).`, {
          curateSlugs: touchedSlugs.length,
        });
      } catch {
        // fire-and-forget：自动策展入队失败不影响本次 ingest 的成功返回
      }
    }
  }

  return result as unknown as Record<string, unknown>;
});

type IndexPage = { slug: string; title: string; summary: string };

/** 合并现有页与本次 plan 页为索引页清单：按 slug 去重（plan 覆盖现有），排除 index/log meta 页。 */
function mergePagesForIndex(
  existing: Array<{ slug: string; title: string; summary: string | null }>,
  planPages: Array<{ slug: string; title: string; summary?: string }>,
): IndexPage[] {
  const bySlug = new Map<string, IndexPage>();
  for (const p of existing) bySlug.set(p.slug, { slug: p.slug, title: p.title, summary: p.summary ?? '' });
  for (const p of planPages) bySlug.set(p.slug, { slug: p.slug, title: p.title, summary: p.summary ?? '' });
  return [...bySlug.values()].filter((p) => p.slug !== 'index' && p.slug !== 'log');
}

/**
 * 收口阶段：跑 ingest-indexer 重建 index.md / log.md（基于现有版本增量改写），
 * 再用 commitPending 把内容页（ctx.pending）与 index/log 一并原子提交。
 */
async function finalizeIngest(
  ctx: AgentContext,
  args: {
    pages: IndexPage[];
    sources: Array<{ sourceId: string; filename: string }>;
    languageDirective: string;
  },
): Promise<IngestResult> {
  const { skillRegistry } = getRuntimeRegistries();
  const indexerSkill = skillRegistry.get('ingest-indexer');
  if (!indexerSkill) throw new Error('Skill not loaded: ingest-indexer');

  // 读现有 index/log 全文（含 overlay 暂存），供 indexer 增量改写；不存在则为 null（首建）。
  const existingIndex = (await ctx.overlay.readPage(ctx.subject.slug, 'index'))?.markdown ?? null;
  const existingLog = (await ctx.overlay.readPage(ctx.subject.slug, 'log'))?.markdown ?? null;

  const run = await runSingle({
    skill: indexerSkill,
    ctx,
    input: {
      subjectSlug: ctx.subject.slug,
      pages: args.pages,
      existingIndex,
      existingLog,
      sources: args.sources,
      languageDirective: args.languageDirective,
    },
  });

  const out = run.output as { indexMd?: string; logMd?: string } | undefined;
  if (typeof out?.indexMd !== 'string' || typeof out?.logMd !== 'string') {
    throw new Error('ingest-indexer produced no indexMd/logMd');
  }

  const metaEntries: ChangesetEntry[] = [
    { action: existingIndex ? 'update' : 'create', path: buildWikiPath(ctx.subject.slug, 'index'), content: out.indexMd },
    { action: existingLog ? 'update' : 'create', path: buildWikiPath(ctx.subject.slug, 'log'), content: out.logMd },
  ];

  // ⑨：把核查累积的网页引用源导入为 source（按需抓正文，extract 失败回落 snippet），
  // 经扩展后的 commitPending 随同一次 ingest commit 落地（raw/sidecar 文件 + page_sources）。
  const cites = ctx.citedSources ? [...ctx.citedSources.values()] : [];
  let webSources: { links: Array<{ sourceId: string; pageSlugs: string[] }>; extraStagePaths: string[] } | undefined;
  if (cites.length > 0) {
    // 按需抓正文：一次性 extract 全部被引用 URL（失败的 URL 不在结果里，回落 snippet）。
    let extractedByUrl = new Map<string, string>();
    try {
      const extracted = await extractContent(cites.map((c) => c.url));
      extractedByUrl = new Map(extracted.map((e) => [e.url, e.content]));
    } catch (err) {
      ctx.emit('ingest:warn', `Web extract failed; falling back to snippets`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const plan = buildWebSourceImports({
      cites,
      subjectSlug: ctx.subject.slug,
      contentFor: (url) => extractedByUrl.get(url) ?? null,
      saveSource: (filename, content) => saveRawSource(ctx.subject, filename, content),
    });
    if (plan.links.length > 0) {
      webSources = { links: plan.links, extraStagePaths: plan.extraStagePaths };
    }
  }

  return commitPending(ctx, metaEntries, webSources);
}

/** 从 URL 派生安全的 .md 文件名（host + 末段 + 短 hash）。 */
export function filenameFromUrl(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 8);
  let base = 'page';
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    base = `${host}-${last}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    base = base.slice(0, 80) || 'page';
  } catch {
    base = 'page';
  }
  return `web-${base}-${hash}.md`;
}

export interface WebSourceImportPlan {
  links: Array<{ sourceId: string; pageSlugs: string[] }>;
  extraStagePaths: string[];
  filenames: string[];
}

/**
 * 把核查累积的网页引用源组装为导入计划（纯逻辑，IO 经回调注入便于测试）。
 * - contentFor(url): extract 正文或 null（null 则用 fallbackContent=snippet）。
 * - saveSource(filename, content, url): 落盘 source，返回 { id }；抛错则跳过该源。
 */
export function buildWebSourceImports(args: {
  cites: CitedSource[];
  subjectSlug: string;
  contentFor: (url: string) => string | null;
  saveSource: (filename: string, content: string, url: string) => { id: string };
}): WebSourceImportPlan {
  const links: Array<{ sourceId: string; pageSlugs: string[] }> = [];
  const extraStagePaths: string[] = [];
  const filenames: string[] = [];
  for (const c of args.cites) {
    const filename = filenameFromUrl(c.url);
    const body = args.contentFor(c.url) ?? c.fallbackContent;
    const fileContent = `# ${c.title}\n\nSource: ${c.url}\n\n${body}`;
    try {
      const saved = args.saveSource(filename, fileContent, c.url);
      links.push({ sourceId: saved.id, pageSlugs: c.citedBy });
      extraStagePaths.push(
        `raw/${args.subjectSlug}/${filename}`,
        `.llm-wiki/sources/${args.subjectSlug}/${saved.id}.json`,
      );
      filenames.push(filename);
    } catch {
      // 单个源失败不阻断其余；frontmatter 中该 URL 仍保留（读者可见引用）。
    }
  }
  return { links, extraStagePaths, filenames };
}
