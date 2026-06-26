/**
 * re-enrich 任务处理器（P4）：对存量页面手动「重新增益」。
 *
 * 复用 ingest 的 agents 流水线，但跳过 writer——现有页正文即忠实层，直接当 draft：
 *   seed writerOutputs（现有正文）→ ingest-enricher（叠 callout）→ verify（联网核查/自检）
 * 之后经 commitPending 单事务收口（不重写 index/log——标题/摘要不变）。
 *
 * 网页 source 的 raw 文件导入是 ingest-only；re-enrich 仅靠 verifier 写进页 frontmatter 的
 * sources URL 留痕（不落 raw/page_sources），简化实现、避免触碰 ingest finalize。
 */
import { randomUUID } from 'node:crypto';
import type { Job, PageMaturity } from '@/lib/contracts';
import type { AgentContext } from '../agents/types';
import { runPipeline, type PipelineStep } from '../agents/runtime/orchestrator';
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import * as maturityRepo from '../db/repos/maturity-repo';
import { createBudgetTracker } from '../agents/runtime/budget';
import { createOverlayVault } from '../agents/runtime/overlay-vault';
import { loadCheckpoint } from '../agents/runtime/checkpoint';
import { commitPending } from '../agents/tools/builtin/commit-changeset';
import {
  getAgentMaxSteps,
  getAgentMaxTokensPerJob,
  getAgentMaxParallelSubAgents,
  getWikiLanguage,
} from '../db/repos/settings-repo';
import { renderLanguageDirective, renderAugmentationDirective } from '../llm/prompts/prompt-context';
import { getRuntimeRegistries } from '../worker-runtime';
import { enqueueEmbedIndex } from './embedding-service';
import { countCallouts, nextMaturity, type MaturityNext } from './maintenance-policy';

interface ReenrichParams {
  slug: string;
  subjectId: string;
}

/** re-enrich 固定两步：现有正文当 draft → enricher → verify。 */
export function reenrichSteps(): PipelineStep[] {
  return [
    { kind: 'fanout', skillId: 'ingest-enricher', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'enricher-page' },
    { kind: 'verify', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
  ];
}

/** 把现有页身份与正文塞进 carry：plan.pages 单页 + writerOutputs seed（enricher 读 draftContent）。 */
export function buildReenrichInitialInput(opts: {
  slug: string;
  title: string;
  summary: string;
  subjectSlug: string;
  draftContent: string;
  languageDirective: string;
  augmentationDirective: string;
}): unknown {
  const path = `wiki/${opts.subjectSlug}/${opts.slug}.md`;
  const page = { slug: opts.slug, title: opts.title, summary: opts.summary };
  return {
    plan: { pages: [page] },
    // enricher 的 injectPriorPageAs:'draftContent' 按 path 从 writerOutputs 取现有正文
    writerOutputs: [{ action: 'update', path, content: opts.draftContent }],
    subjectSlug: opts.subjectSlug,
    existingPages: [page], // 命中 → enricher/verify 用 action=update
    languageDirective: opts.languageDirective,
    augmentationDirective: opts.augmentationDirective,
  };
}

/** 用「新增 callout 数」作收敛信号，结合当前成熟度推导下一态。 */
export function deriveMaturityUpdate(opts: {
  draftContent: string;
  finalContent: string;
  current: PageMaturity | null;
  now: Date;
}): MaturityNext {
  const newIncrement = Math.max(0, countCallouts(opts.finalContent) - countCallouts(opts.draftContent));
  return nextMaturity(
    {
      state: opts.current?.state ?? 'active',
      passes: opts.current?.passes ?? 0,
      intervalDays: opts.current?.intervalDays ?? 1,
      newIncrement,
    },
    opts.now,
  );
}

registerHandler('re-enrich', async (job: Job, emit): Promise<Record<string, unknown>> => {
  const params = JSON.parse(job.paramsJson) as Partial<ReenrichParams>;
  const { slug, subjectId } = params;
  if (!slug || !subjectId) throw new Error('re-enrich job missing slug or subjectId');
  if (slug === 'index' || slug === 'log') throw new Error('Cannot re-enrich a meta page (index/log)');

  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);
  const page = pagesRepo.getPageBySlug(subjectId, slug);
  if (!page) throw new Error(`Page "${slug}" not found in subject ${subject.slug}`);

  emit('reenrich:start', `Re-enriching ${slug}`, { subject: subject.slug, slug });

  const { skillRegistry, toolRegistry } = getRuntimeRegistries();
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-enricher': 3, 'ingest-verifier': 2,
    'ingest-verifier-triage': 1, 'ingest-verifier-apply': 1,
  };
  for (const [skillId, minVersion] of Object.entries(MIN_SKILL_VERSIONS)) {
    const s = skillRegistry.get(skillId);
    if (!s) throw new Error(`Skill not loaded: ${skillId}`);
    if (s.version < minVersion) {
      throw new Error(
        `Skill "${skillId}" is v${s.version} but re-enrich requires v${minVersion}+. ` +
        `Delete vault/.llm-wiki/skills/${skillId}.md and restart the worker to re-seed.`,
      );
    }
  }

  const budgetSnapshot = {
    maxSteps: getAgentMaxSteps(),
    maxTokensPerJob: getAgentMaxTokensPerJob(),
    maxParallelSubAgents: getAgentMaxParallelSubAgents(),
  };
  const budget = createBudgetTracker(budgetSnapshot);
  const overlay = createOverlayVault({ subjectSlug: subject.slug });
  const checkpoint = loadCheckpoint(job.id);

  const existing = await overlay.readPage(subject.slug, slug);
  if (!existing?.markdown) throw new Error(`Existing content not found for ${slug}`);

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
    chunkStore: new Map(),
    budgetSnapshot,
    checkpoint,
    citedSources: new Map(),
  };
  for (const c of checkpoint.getCitedSources()) ctx.citedSources!.set(c.url, c);

  // 手动 re-enrich：subject 即便设 off 也按 standard 跑（用户显式触发）。
  const level = subject.augmentationLevel === 'off' ? 'standard' : subject.augmentationLevel;
  const languageDirective = renderLanguageDirective(getWikiLanguage());
  const augmentationDirective = renderAugmentationDirective(level);

  await runPipeline({
    steps: reenrichSteps(),
    resolveSkill: (id) => {
      const s = skillRegistry.get(id);
      if (!s) throw new Error(`Skill not loaded: ${id}`);
      return s;
    },
    ctx,
    initialInput: buildReenrichInitialInput({
      slug,
      title: page.title,
      summary: page.summary,
      subjectSlug: subject.slug,
      draftContent: existing.markdown,
      languageDirective,
      augmentationDirective,
    }),
  });

  // 流水线把核查后页 upsert 进 ctx.pending；commitPending 提交（无 index/log meta）。
  const result = await commitPending(ctx, []);

  // 维护层：用本遍 callout 增量推进成熟度（draft = 旧正文，final = 提交版正文）。
  const path = `wiki/${subject.slug}/${slug}.md`;
  const finalContent = ctx.pending.entries.find((e) => e.path === path)?.content ?? existing.markdown;
  const now = new Date();
  const next = deriveMaturityUpdate({
    draftContent: existing.markdown,
    finalContent,
    current: maturityRepo.get(subject.id, slug),
    now,
  });
  maturityRepo.applyAfterEnrich(subject.id, slug, next, now.toISOString());
  emit('reenrich:maturity', `Maturity → ${next.state}, next in ${next.intervalDays}d`, {
    slug,
    passes: next.passes,
    state: next.state,
    intervalDays: next.intervalDays,
  });

  checkpoint.clear();
  enqueueEmbedIndex(subject.id);
  return result as unknown as Record<string, unknown>;
});
