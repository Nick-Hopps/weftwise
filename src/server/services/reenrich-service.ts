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
import * as queue from '../jobs/queue';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import * as maturityRepo from '../db/repos/maturity-repo';
import { getProfileOrDefault } from '../db/repos/profiles-repo';
import { LOCAL_USER_ID } from '../middleware/user';
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
import { countCallouts, nextMaturity, proseGrowthIncrement, type MaturityNext } from './maintenance-policy';
import { countPageDeterministicFindings, pageHasStaleSources } from './page-quality-signal';

interface ReenrichParams {
  slug: string;
  subjectId: string;
}

/** re-enrich 固定三步：现有正文当 draft → supplement（补讲解缺口）→ enricher → verify。 */
export function reenrichSteps(): PipelineStep[] {
  return [
    { kind: 'supplement', skillId: 'reenrich-supplement', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'supplement-page' },
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
  profileHint: string;
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
    profileHint: opts.profileHint,
  };
}

/**
 * 把认知画像拼成 supplement 阶段的「探针提示」：
 * 画像只用来定位「读者大概率不懂的概念」，但补充内容本身必须写成中性、对任何读者都普遍适用的讲解
 * （读者专属讲法归读时 Cognitive Lens，不在 canonical 里做）。无背景时回落中性中级读者假设。
 */
export function buildProfileHint(profile: {
  backgroundSummary: string;
  stylePrefs: { readingLevel: string; verbosity: string; exampleDensity: string };
}): string {
  const { readingLevel, verbosity, exampleDensity } = profile.stylePrefs;
  const bg = profile.backgroundSummary.trim();
  const reader = bg
    ? `The reader's background: ${bg}. Reading level: ${readingLevel}.`
    : `Assume a general intermediate reader (reading level: ${readingLevel}).`;
  return (
    `${reader} Verbosity preference: ${verbosity}; example density: ${exampleDensity}. ` +
    `Use this ONLY as a probe to spot which concepts most readers would likely find unexplained or confusing, ` +
    `then fill those gaps. The supplement you write MUST be neutral, universally-useful canonical exposition — ` +
    `never phrase it as if it only applies to this one reader.`
  );
}

/**
 * 用「新增 callout 数 + 正文增长折算」合并体量信号，结合 T1.8 质量信号（qualityDelta/
 * staleSource，由调用方在 IO 层用 `page-quality-signal.ts` 算好传入）推导下一态。
 * 本函数保持纯——不做任何 DB/FS 访问。
 */
export function deriveMaturityUpdate(opts: {
  draftContent: string;
  finalContent: string;
  current: PageMaturity | null;
  now: Date;
  qualityDelta: number;
  staleSource: boolean;
}): MaturityNext {
  const calloutDelta = Math.max(0, countCallouts(opts.finalContent) - countCallouts(opts.draftContent));
  // 体量信号：callout 增量 + 正文增长折算（防「多补正文少加 callout」被误判无进展）；
  // 是否计入由 nextMaturity 按 qualityDelta 决定（质量优先，体量不改善时清零）。
  const newIncrement = calloutDelta + proseGrowthIncrement(opts.draftContent, opts.finalContent);
  return nextMaturity(
    {
      state: opts.current?.state ?? 'active',
      passes: opts.current?.passes ?? 0,
      intervalDays: opts.current?.intervalDays ?? 1,
      newIncrement,
      qualityDelta: opts.qualityDelta,
      staleSource: opts.staleSource,
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
    'reenrich-supplement': 1,
    'ingest-enricher': 4, 'ingest-verifier': 2,
    'ingest-verifier-triage': 2, 'ingest-verifier-apply': 3,
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
    cancelled: () => queue.isCancelRequested(job.id),
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
  const profileHint = buildProfileHint(getProfileOrDefault(LOCAL_USER_ID));

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
      profileHint,
    }),
  });

  // 流水线把核查后页 upsert 进 ctx.pending；commitPending 提交（无 index/log meta）。
  const result = await commitPending(ctx, []);

  // 维护层：用本遍 callout 增量（体量）+ 质量信号推进成熟度（draft = 旧正文，final = 提交版正文）。
  const path = `wiki/${subject.slug}/${slug}.md`;
  const finalContent = ctx.pending.entries.find((e) => e.path === path)?.content ?? existing.markdown;
  const now = new Date();

  // T1.8 质量信号（全确定性、零额外 LLM 调用）：
  //   - 确定性分量：单页 broken-link + frontmatter findings，「修复前 − 修复后」= 改善量；
  //   - verify 分量：本轮 verify 阶段实际写入 ctx.citedSources 的证据条数（有证据修正才计正）。
  // 拿不到结构化 verify 修订计数（apply 只回传最终正文，不单独暴露"修了几处"），故 verify 分量
  // 退化为「本轮新增几条被引用来源」这个确定性代理——同样零 LLM 调用，符合验收要求的降级说明。
  const preFindings = countPageDeterministicFindings({
    subjectId: subject.id,
    pageSlug: slug,
    content: existing.markdown,
  });
  const postFindings = countPageDeterministicFindings({
    subjectId: subject.id,
    pageSlug: slug,
    content: finalContent,
  });
  const deterministicDelta = preFindings - postFindings;
  const verifyDelta = ctx.citedSources ? ctx.citedSources.size : 0;
  const qualityDelta = deterministicDelta + verifyDelta;
  const staleSource = pageHasStaleSources(subject, slug);

  const next = deriveMaturityUpdate({
    draftContent: existing.markdown,
    finalContent,
    current: maturityRepo.get(subject.id, slug),
    now,
    qualityDelta,
    staleSource,
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
