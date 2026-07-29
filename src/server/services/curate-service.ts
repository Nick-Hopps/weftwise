/**
 * Curate service — 任务类型 'curate'：tool-loop 驱动的页面策展。
 * 模型读页后自行调 wiki.merge/split/delete/create；写能力经 CurateGuard 硬护栏把守。
 * params: { scope: 'pages' | 'subject'; slugs?: string[]; subjectId }
 *  - 'pages'(auto)：scope = slugs(本次 ingest 受影响页) + 本-subject 邻居；seed 限制生效。
 *  - 'subject'(manual)：scope = 全 subject 非 meta 页；无 seed 限制、允许 create。
 */
import { registerHandler } from '../jobs/worker';
import * as queue from '../jobs/queue';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { expandScopeWithNeighbors, createCurateGuard } from '../wiki/curate-plan';
import { META_PAGE_SLUGS } from '../wiki/page-identity';
import { buildCurateToolContext } from './curate-tools';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import { createToolExecutionPolicy, resolveToolProfile } from '@/server/agents/tools/profiles';
import { generateTextWithTools } from '../llm/provider-registry';
import { CURATE_AGENTIC_SYSTEM_PROMPT, buildCurateAgenticUserPrompt } from '../llm/prompts/curate-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import { toolActivityLine } from '@/lib/tool-activity';
import type {
  EnrichedLintFinding,
  Job,
  PostconditionReport,
  RemediationContext,
  Subject,
} from '@/lib/contracts';
import { verifyJobPostconditions } from './postcondition-service';
import { readRemediationContext } from './remediation-context';
import { selectLatestFindings } from './lint-latest';
import { pageHasInboundLinks } from './lint-deterministic';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';

/** 工具循环最大步数（bound 读取轮次；写次数由 guard caps 真正兜底）。 */
export const CURATE_MAX_STEPS = 40;
const CURATE_CAPS = { merge: 5, split: 5, delete: 5, create: 5, update: 5 };

interface CurateTotals {
  merge: number;
  split: number;
  delete: number;
  create: number;
  update: number;
  writes: number;
}

type CurateFindingOutcome = 'fixed' | 'failed' | 'skipped';

type CurateEmit = (
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

async function completeCurate(
  totals: CurateTotals,
  worklist: EnrichedLintFinding[],
  baseMessage: string,
  job: Job,
  subject: Subject,
  emit: CurateEmit,
): Promise<Record<string, unknown>> {
  const postcondition = await verifyJobPostconditions({
    kind: 'curate',
    job,
    subject,
    semanticFindings: undefined,
    emit,
  });
  const perFindingOutcomes = buildCuratePerFindingOutcomes(
    worklist,
    postcondition,
    // 后置校验之后现场重查，读到的是本次写入落盘并 reindex 之后的事实
    (slug) => pageHasInboundLinks(subject, slug),
  );
  const result = {
    ...totals,
    postconditionStatus: postcondition.status,
    residualCount: postcondition.residualFindings.length,
    semanticStatus: postcondition.semanticStatus,
    perFindingOutcomes,
    postcondition,
  };
  const verificationText = postcondition.status === 'clean'
    ? 'Postcondition clean.'
    : `Postcondition residual: ${postcondition.residualFindings.length} issue(s).`;
  emit('curate:complete', `${baseMessage} ${verificationText}`, result);
  return result;
}

/** 从精确 lint 快照恢复 scoped orphan worklist；legacy Curate 没有 context 时返回空清单。 */
function resolveCurateWorklist(
  subjectId: string,
  context: RemediationContext | null,
): EnrichedLintFinding[] {
  if (!context) return [];
  if (context.action !== 'curate') {
    throw new Error('Curate remediation action mismatch');
  }

  const lintJob = queue.get(context.lintJobId);
  if (
    !lintJob
    || lintJob.type !== 'lint'
    || lintJob.status !== 'completed'
    || lintJob.subjectId !== subjectId
  ) {
    throw new Error('Curate lint snapshot is missing or belongs to another subject');
  }
  const snapshot = selectLatestFindings([lintJob]);
  if (snapshot.jobId !== context.lintJobId) {
    throw new Error('Curate lint snapshot mismatch');
  }

  const requestedIds = new Set(context.findingIds);
  const worklist = snapshot.findings.filter((finding) => requestedIds.has(finding.id));
  if (worklist.length !== requestedIds.size) {
    throw new Error('Curate finding scope is stale');
  }
  if (worklist.some((finding) => finding.type !== 'orphan')) {
    throw new Error('Curate remediation contains a non-orphan finding');
  }
  return worklist;
}

/**
 * 按 residual 的 pageSlug / relatedSlugs 将 Curate 批次结果归因到原 orphan。
 *
 * `fixed` 的判据是**孤页现在是否真有非 meta 入链**（`hasInbound`），不是「孤页有没有被写过」——
 * 孤页的修复天然写在**源页**上，孤页自己永远不会出现在 `postcondition.scope.touchedSlugs` 里，
 * 按 touchedSlugs 判会让补链成功也被记成 skipped。这个判据也更强：它验的是问题本身没了。
 * `failed` 的三条既有路径（校验异常 / 未归因 residual / 命中 residual）优先级不变，仍然最保守。
 */
function buildCuratePerFindingOutcomes(
  worklist: EnrichedLintFinding[],
  postcondition: PostconditionReport,
  hasInbound: (slug: string) => boolean,
): Record<string, CurateFindingOutcome> {
  const outcomes: Record<string, CurateFindingOutcome> = {};
  if (worklist.length === 0) return outcomes;

  const allFailed = postcondition.verificationError !== null
    || (
      postcondition.status === 'residual'
      && postcondition.residualFindings.length === 0
    );
  const failedIds = new Set<string>();
  let hasUnattributedResidual = false;

  if (!allFailed) {
    for (const residual of postcondition.residualFindings) {
      const relatedSlugs = new Set([
        ...(residual.pageSlug ? [residual.pageSlug] : []),
        ...(residual.relatedSlugs ?? []),
      ]);
      const matches = worklist.filter((finding) => relatedSlugs.has(finding.pageSlug));
      if (matches.length === 0) {
        hasUnattributedResidual = true;
        break;
      }
      for (const finding of matches) failedIds.add(finding.id);
    }
  }

  for (const finding of worklist) {
    if (allFailed || hasUnattributedResidual || failedIds.has(finding.id)) {
      outcomes[finding.id] = 'failed';
    } else if (!hasInbound(finding.pageSlug)) {
      outcomes[finding.id] = 'skipped';
    } else {
      outcomes[finding.id] = 'fixed';
    }
  }
  return outcomes;
}

/** 每个孤页最多引入几个语义候选源页。每多一页就多一份写 scope 护栏面，故设上界。 */
const ORPHAN_SOURCE_CANDIDATES = 5;

/**
 * 给 orphan worklist 补上「谁最该链到它」的候选源页。
 *
 * 孤页的定义就是**没有入链**，所以 `expandScopeWithNeighbors` 的一跳图邻居只剩它自己链出去
 * 的那几页——一个与「谁该链到它」几乎无关的集合。「哪一页最该提到这个概念」本质是语义相似度
 * 问题，因此这里改用既有混合检索（FTS + 向量 RRF）取候选，让写 scope 落在真正相关的页上。
 *
 * 只在带 orphan worklist 时执行：manual Tidy 与 ingest 后的自动 Curate 一次检索都不发，
 * allowedSet 逐元素不变。
 */
async function expandScopeWithOrphanSourceCandidates(
  scopeSlugs: string[],
  worklist: EnrichedLintFinding[],
  subject: Subject,
  emit: CurateEmit,
): Promise<string[]> {
  const out = new Set(scopeSlugs);
  const orphanSlugs = new Set(worklist.map((finding) => finding.pageSlug));

  for (const finding of worklist) {
    const page = readPageInSubject(subject.slug, finding.pageSlug);
    const query = [page?.frontmatter.title, page?.frontmatter.summary]
      .filter((part): part is string => Boolean(part))
      .join(' ')
      || finding.pageSlug;

    const ranked = await hybridRankSlugs(subject.id, query, ORPHAN_SOURCE_CANDIDATES);
    const candidates = ranked.filter(
      (slug) => !META_PAGE_SLUGS.has(slug) && !orphanSlugs.has(slug),
    );
    for (const slug of candidates) out.add(slug);

    emit(
      'curate:orphan-candidates',
      candidates.length > 0
        ? `Candidate source pages for "${finding.pageSlug}": ${candidates.join(', ')}`
        : `No candidate source page found for "${finding.pageSlug}".`,
      { orphanSlug: finding.pageSlug, candidates },
    );
  }

  return [...out];
}

export async function runCurateJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as { scope?: 'pages' | 'subject'; slugs?: string[]; subjectId?: string };
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('curate job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);
  const hasRemediationContext = Object.prototype.hasOwnProperty.call(
    params,
    'remediationContext',
  );
  const remediationContext = readRemediationContext(job);
  if (hasRemediationContext && !remediationContext) {
    throw new Error('Curate remediation context is invalid');
  }
  const worklist = resolveCurateWorklist(subject.id, remediationContext);

  // 1. 解析 scope + seedSet
  let scopeSlugs: string[];
  let seedSet: Set<string> | null;
  if (params.scope === 'pages' && Array.isArray(params.slugs)) {
    const seed = params.slugs.filter((s) => !META_PAGE_SLUGS.has(s));
    seedSet = new Set(seed);
    const links = pagesRepo.getAllLinks(subject.id);
    scopeSlugs = expandScopeWithNeighbors(seed, links, subject.id, META_PAGE_SLUGS);
    if (worklist.length > 0) {
      scopeSlugs = await expandScopeWithOrphanSourceCandidates(
        scopeSlugs,
        worklist,
        subject,
        emit,
      );
    }
  } else {
    seedSet = null;
    scopeSlugs = pagesRepo.getAllPages(subject.id).map((p) => p.slug).filter((s) => !META_PAGE_SLUGS.has(s));
  }

  emit('curate:start', `Curating ${scopeSlugs.length} page(s) in "${subject.slug}"…`, {
    scope: params.scope ?? 'subject',
    count: scopeSlugs.length,
  });

  if (scopeSlugs.length === 0) {
    return completeCurate(
      { merge: 0, split: 0, delete: 0, create: 0, update: 0, writes: 0 },
      worklist,
      'Nothing to curate (empty scope).',
      job,
      subject,
      emit,
    );
  }

  // 2. scope 元数据（slug/title/summary/tags/bodyChars，不喂正文——模型用 wiki.read 自取）
  const metas: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[] = [];
  for (const slug of scopeSlugs) {
    const doc = readPageInSubject(subject.slug, slug);
    if (!doc) continue;
    metas.push({
      slug,
      title: doc.frontmatter.title,
      summary: doc.frontmatter.summary ?? '',
      tags: doc.frontmatter.tags ?? [],
      bodyChars: doc.body.length,
    });
  }

  // 3. 装配 guard + worker ToolContext + 工具集
  const allowedSet = new Set(scopeSlugs);
  const guard = createCurateGuard({ seedSet, allowedSet, caps: CURATE_CAPS });
  const ctx = buildCurateToolContext(subject, { guard, jobId: job.id, emit });
  const profile = resolveToolProfile(seedSet === null ? 'curate:manual' : 'curate:auto');
  const tools = compileToolSet(createBuiltinToolRegistry().resolve([...profile.tools]), ctx, {
    policy: createToolExecutionPolicy(profile, subject.id, {
      allowedPageSlugs: allowedSet,
      jobCapability: { jobId: job.id, jobType: job.type },
    }),
  });

  const promptCtx = {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };

  emit('curate:agent:start', `Reviewing ${metas.length} candidate page(s) (mode: ${seedSet === null ? 'manual' : 'auto'}, caps: ${Object.entries(CURATE_CAPS).map(([k, v]) => `${k}≤${v}`).join(' ')})…`, {
    candidates: metas.length,
    mode: seedSet === null ? 'manual' : 'auto',
    caps: CURATE_CAPS,
  });

  // 4. 驱动工具循环
  await generateTextWithTools('curate', {
    system: CURATE_AGENTIC_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: buildCurateAgenticUserPrompt(metas, promptCtx, {
        auto: seedSet !== null,
        // worklist 已由 resolveCurateWorklist 保证是同 subject、同快照的 orphan；
        // 空数组（manual / ingest 后自动 Curate）时 prompt 逐字节退回原样。
        orphans: worklist.map((finding) => ({
          pageSlug: finding.pageSlug,
          description: finding.description,
          suggestedFix: finding.suggestedFix,
        })),
      }),
    }],
    tools,
    maxSteps: CURATE_MAX_STEPS,
    usageSubjectId: subject.id,
    shouldCancel: () => queue.isCancelRequested(job.id),
    onToolCall: (info) => emit('curate:tool', toolActivityLine(info.tool, info.args), { tool: info.tool }),
  });

  const totals = guard.totals();
  if (totals.writes > 0) enqueueEmbedIndex(subject.id);

  return completeCurate(
    totals,
    worklist,
    `Curation done: ${totals.merge} merge(s), ${totals.split} split(s), ${totals.delete} delete(s), ${totals.create} create(s), ${totals.update} update(s).`,
    job,
    subject,
    emit,
  );
}

registerHandler('curate', runCurateJob);
