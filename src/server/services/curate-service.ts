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

/** 工具循环最大步数（bound 读取轮次；写次数由 guard caps 真正兜底）。 */
export const CURATE_MAX_STEPS = 40;
const CURATE_CAPS = { merge: 5, split: 5, delete: 5, create: 5 };

interface CurateTotals {
  merge: number;
  split: number;
  delete: number;
  create: number;
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

/** 按 residual 的 pageSlug / relatedSlugs 将 Curate 批次结果归因到原 orphan。 */
function buildCuratePerFindingOutcomes(
  worklist: EnrichedLintFinding[],
  postcondition: PostconditionReport,
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
  const touchedSlugs = postcondition.scope.touchedSlugs.length > 0
    ? new Set(postcondition.scope.touchedSlugs)
    : new Set([
      ...postcondition.scope.createdSlugs,
      ...postcondition.scope.updatedSlugs,
      ...postcondition.scope.deletedSlugs,
    ]);

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
    } else if (!touchedSlugs.has(finding.pageSlug)) {
      outcomes[finding.id] = 'skipped';
    } else {
      outcomes[finding.id] = 'fixed';
    }
  }
  return outcomes;
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
  } else {
    seedSet = null;
    scopeSlugs = pagesRepo.getAllPages(subject.id).map((p) => p.slug).filter((s) => !META_PAGE_SLUGS.has(s));
  }

  emit('curate:start', `Curating ${scopeSlugs.length} page(s) in "${subject.slug}"…`, {
    scope: params.scope ?? 'subject',
    count: scopeSlugs.length,
  });

  if (scopeSlugs.length < 2) {
    return completeCurate(
      { merge: 0, split: 0, delete: 0, create: 0, writes: 0 },
      worklist,
      'Nothing to curate (need at least 2 pages).',
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
    messages: [{ role: 'user', content: buildCurateAgenticUserPrompt(metas, promptCtx, { auto: seedSet !== null }) }],
    tools,
    maxSteps: CURATE_MAX_STEPS,
    shouldCancel: () => queue.isCancelRequested(job.id),
    onToolCall: (info) => emit('curate:tool', toolActivityLine(info.tool, info.args), { tool: info.tool }),
  });

  const totals = guard.totals();
  if (totals.writes > 0) enqueueEmbedIndex(subject.id);

  return completeCurate(
    totals,
    worklist,
    `Curation done: ${totals.merge} merge(s), ${totals.split} split(s), ${totals.delete} delete(s), ${totals.create} create(s).`,
    job,
    subject,
    emit,
  );
}

registerHandler('curate', runCurateJob);
