/**
 * Fix service — 任务类型 'fix'：一键修复 Health lint findings。
 * 工作清单 = 新鲜重扫确定性（missing-frontmatter / broken-link）∪ 最近 lint 快照语义
 *   （missing-crossref / contradiction）。
 * 阶段1（pre-pass，确定性）：所有 missing-frontmatter 合并为一个 Saga commit。
 * 阶段2（tool-loop）：generateTextWithTools('fix') 驱动，模型自驱读页 + wiki.update 修复
 *   （不提供 wiki.create——断链只允许重链/解链，禁止补建占位 stub 页）；
 *   写能力经 FixGuard（写 cap + 保护页）+ 忠实度护栏把守，坏链/残链由内核确定性拒绝。每写一次一个 commit。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('fix', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as queue from '../jobs/queue';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { enqueueEmbedIndex } from './embedding-service';
import { runDeterministicChecksForSubject } from './lint-deterministic';
import { selectLatestFindings } from './lint-latest';
import { identifyFindings } from './finding-identity';
import {
  DETERMINISTIC_FIX_TYPES,
  LLM_FIX_TYPES,
  fixMissingFrontmatter,
  partitionFindings,
  buildFixWorklist,
  buildSubjectReportLines,
  createFixGuard,
  fixWritableSlugs,
} from './fix-deterministic';
import { normalizeRemediationContext } from './remediation-context';
import { buildFixToolContext } from './fix-tools';
import { readPageInSubject } from '../wiki/wiki-store';
import { buildWikiPath } from '../wiki/page-identity';
import { createChangeset, validateChangeset, applyChangeset } from '../wiki/wiki-transaction';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import { createToolExecutionPolicy, resolveToolProfile } from '@/server/agents/tools/profiles';
import { generateTextWithTools } from '../llm/provider-registry';
import { buildFixAgenticSystemPrompt, buildFixAgenticUserPrompt } from '../llm/prompts/fix-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import { toolActivityLine } from '@/lib/tool-activity';
import type {
  ChangesetEntry,
  EnrichedLintFinding,
  Job,
  LintLatestResult,
  PostconditionReport,
  RemediationContext,
} from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';
import { verifyJobPostconditions } from './postcondition-service';

/** 工具循环最大步数（bound 读取轮次；写次数由 FixGuard cap 真正兜底）。 */
export const FIX_MAX_STEPS = 60;

interface FixParams {
  subjectId: string;
  remediationContext?: RemediationContext;
}

const FINDING_ID_PATTERN = /^[0-9a-f]{64}$/;
type FixFindingOutcome = 'fixed' | 'failed' | 'skipped';

const SEMANTIC_FIX_TYPES: ReadonlySet<EnrichedLintFinding['type']> = new Set([
  'missing-crossref',
  'contradiction',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EMPTY_SLUGS: ReadonlySet<string> = new Set<string>();

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * 依据实际工作清单与后置校验，为批量 Fix 中每个稳定 finding ID 单独归因。
 *
 * 两处判据都按「该 finding 的处置落点」而不是 `finding.pageSlug`（`fixWritableSlugs`
 * 单一口径，与写白名单同源）：contradiction 的修复常常只写对侧页，按 pageSlug 判会让
 * 修好了也记成 skipped —— 与 2026-07-29 orphan 的 `touchedSlugs` 误判同族。
 *
 * `blockedWrite` 表示本次 job 有写入被写白名单挡下。归因精度：被拒的 slug 按定义不在任何
 * finding 的可写集里，无法反查「为哪条 finding 而拒」，因此**逐条处置时精确，批量处置时偏
 * 保守**（同批里模型主动留着的 LLM 类 finding 也会被记为 failed）。宁可多报一次失败让用户
 * 能重试，也不再把「改不了」静默成「无需更改」。
 */
function buildPerFindingOutcomes(
  worklist: EnrichedLintFinding[],
  postcondition: PostconditionReport,
  blockedWrite: boolean,
): Record<string, FixFindingOutcome> {
  const residualKeys = new Set(
    postcondition.residualFindings.map(
      (finding) => JSON.stringify([finding.type, finding.pageSlug]),
    ),
  );
  const touchedSlugs = postcondition.scope.touchedSlugs.length > 0
    ? new Set(postcondition.scope.touchedSlugs)
    : new Set([
      ...postcondition.scope.createdSlugs,
      ...postcondition.scope.updatedSlugs,
      ...postcondition.scope.deletedSlugs,
    ]);
  const outcomes: Record<string, FixFindingOutcome> = {};

  for (const finding of worklist) {
    const hasMatchingResidual = residualKeys.has(
      JSON.stringify([finding.type, finding.pageSlug]),
    );
    const touchedAnyWritablePage = [...fixWritableSlugs([finding])]
      .some((slug) => touchedSlugs.has(slug));
    if (
      postcondition.verificationError !== null
      || hasMatchingResidual
    ) {
      outcomes[finding.id] = 'failed';
    } else if (!touchedAnyWritablePage) {
      outcomes[finding.id] = blockedWrite && LLM_FIX_TYPES.has(finding.type)
        ? 'failed'
        : 'skipped';
    } else if (
      postcondition.semanticStatus === 'failed'
      && SEMANTIC_FIX_TYPES.has(finding.type)
    ) {
      outcomes[finding.id] = 'failed';
    } else {
      outcomes[finding.id] = 'fixed';
    }
  }

  return outcomes;
}

/** 严格解析 Fix 参数；仅 remediationContext 属性完全缺失时进入 legacy 模式。 */
function parseFixParams(job: Job): FixParams {
  let raw: unknown;
  try {
    raw = JSON.parse(job.paramsJson);
  } catch {
    throw new Error('Fix params are not valid JSON');
  }
  if (!isRecord(raw)) throw new Error('Fix params must be an object');

  let paramsSubjectId: string | undefined;
  if (hasOwn(raw, 'subjectId')) {
    if (typeof raw.subjectId !== 'string' || raw.subjectId.trim().length === 0) {
      throw new Error('Fix params subjectId must be a non-empty string');
    }
    paramsSubjectId = raw.subjectId;
  }
  if (
    paramsSubjectId !== undefined
    && job.subjectId !== null
    && paramsSubjectId !== job.subjectId
  ) {
    throw new Error('Fix params subjectId does not match job subjectId');
  }
  const subjectId = paramsSubjectId ?? job.subjectId;
  if (!subjectId) throw new Error('fix job missing subjectId');

  if (!hasOwn(raw, 'remediationContext')) return { subjectId };
  const context = raw.remediationContext;
  if (!isRecord(context)) throw new Error('Fix remediation context must be an object');
  if (context.action !== 'fix') throw new Error('Fix remediation action mismatch');
  if (typeof context.lintJobId !== 'string' || context.lintJobId.trim().length === 0) {
    throw new Error('Fix remediation lintJobId must be non-empty');
  }
  if (
    !Array.isArray(context.findingIds)
    || context.findingIds.length === 0
    || !context.findingIds.every(
      (findingId) => typeof findingId === 'string' && FINDING_ID_PATTERN.test(findingId),
    )
  ) {
    throw new Error('Fix remediation findingIds must contain valid finding IDs');
  }

  return {
    subjectId,
    remediationContext: normalizeRemediationContext({
      lintJobId: context.lintJobId,
      findingIds: context.findingIds,
      action: 'fix',
    }),
  };
}

function lintSnapshotForFix(
  subjectId: string,
  context?: RemediationContext,
): LintLatestResult {
  if (!context) {
    return selectLatestFindings(
      queue.list({ type: 'lint', status: 'completed', subjectId }),
    );
  }

  const lintJob = queue.get(context.lintJobId);
  if (
    !lintJob
    || lintJob.type !== 'lint'
    || lintJob.status !== 'completed'
    || lintJob.subjectId !== subjectId
  ) {
    throw new Error('Fix lint snapshot is missing or belongs to another subject');
  }

  const snapshot = selectLatestFindings([lintJob]);
  if (snapshot.jobId !== context.lintJobId) {
    throw new Error('Fix lint snapshot mismatch');
  }
  return snapshot;
}

function selectedFixScope(
  snapshot: LintLatestResult,
  context?: RemediationContext,
): {
  requestedIds: ReadonlySet<string> | null;
  semantic: EnrichedLintFinding[];
} {
  const snapshotSemantic = snapshot.findings.filter(
    (finding) => finding.type === 'missing-crossref' || finding.type === 'contradiction',
  );
  if (!context) {
    return { requestedIds: null, semantic: snapshotSemantic };
  }

  const requested = new Set(context.findingIds);
  const snapshotMatches = snapshot.findings.filter((finding) => requested.has(finding.id));
  if (snapshotMatches.length !== requested.size) {
    throw new Error('Fix finding scope is stale');
  }
  if (snapshotMatches.some((finding) => (
    !DETERMINISTIC_FIX_TYPES.has(finding.type) && !LLM_FIX_TYPES.has(finding.type)
  ))) {
    throw new Error('Fix remediation contains a non-fix finding');
  }

  return {
    requestedIds: requested,
    semantic: snapshotSemantic.filter((finding) => requested.has(finding.id)),
  };
}

/**
 * scoped Fix 只收窄写侧；read/search/inspect/source evidence 仍保持 subject-wide。
 *
 * 被拒的 slug 记进闭包 `blockedSlugs` 并 emit 事件：`fix:tool` 走的是 AI SDK
 * `onStepFinish`，只报「发起了哪些 tool call」、拿不到执行结果，被拒的写入在日志里
 * 与成功写入长得一模一样。归因判据（`buildPerFindingOutcomes`）也需要这个信号来区分
 * 「被门控挡住」与「模型主动留着」，两者都表现为零写入。
 */
function scopeFixWrites(
  context: ToolContext,
  allowedPageSlugs: ReadonlySet<string>,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): { context: ToolContext; blockedSlugs: Set<string> } {
  const blockedSlugs = new Set<string>();
  const allowed = [...allowedPageSlugs];
  const assertAllowed = (slug: string): void => {
    if (allowedPageSlugs.has(slug)) return;
    blockedSlugs.add(slug);
    emit(
      'fix:scope-blocked',
      `Refused to write "${slug}": outside the pages selected for this Fix (${allowed.join(', ')}).`,
      { slug, allowed },
    );
    throw new Error(
      `[PAGE_OUT_OF_SCOPE] ${slug} is outside selected Fix findings; writable pages: ${allowed.join(', ')}`,
    );
  };

  return {
    blockedSlugs,
    context: {
      ...context,
      updatePage: context.updatePage && (async (input) => {
        assertAllowed(input.slug);
        return context.updatePage!(input);
      }),
      patchPage: context.patchPage && (async (input) => {
        assertAllowed(input.slug);
        return context.patchPage!(input);
      }),
      linkEnsure: context.linkEnsure && (async (input) => {
        // target 只用于存在性验证；唯一写对象是 source page。
        assertAllowed(input.sourceSlug);
        return context.linkEnsure!(input);
      }),
    },
  };
}

export async function runFixJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = parseFixParams(job);
  const subject = subjectsRepo.getById(params.subjectId);
  if (!subject) throw new Error(`Subject ${params.subjectId} not found`);
  const remediationContext = params.remediationContext;

  // 1. 工作清单：确定性新鲜重扫 + 快照语义
  const snapshot = lintSnapshotForFix(subject.id, remediationContext);
  const selectedScope = selectedFixScope(snapshot, remediationContext);
  const freshDeterministic = identifyFindings(
    runDeterministicChecksForSubject(subject)
      .filter((finding) => (
        finding.type === 'missing-frontmatter' || finding.type === 'broken-link'
      ))
      .map((finding) => ({
        ...finding,
        subjectId: subject.id,
        subjectSlug: subject.slug,
      })),
  );
  const requestedIds = selectedScope.requestedIds;
  const selectedDeterministic = requestedIds
    ? freshDeterministic.filter((finding) => requestedIds.has(finding.id))
    : freshDeterministic;

  const worklist = buildFixWorklist(selectedDeterministic, selectedScope.semantic);
  const { frontmatter, llm: loop } = partitionFindings(worklist);

  emit('fix:start', `Fixing ${frontmatter.length + loop.length} issue(s) in "${subject.slug}"…`, {
    deterministic: frontmatter.length,
    semantic: loop.length,
  });

  // 2. pre-pass：确定性补 frontmatter —— 合并为一个 commit
  let deterministicFixed = 0;
  if (frontmatter.length > 0) {
    const now = new Date().toISOString();
    const entries: ChangesetEntry[] = [];
    for (const finding of frontmatter) {
      const doc = readPageInSubject(subject.slug, finding.pageSlug);
      if (!doc) continue;
      entries.push({ action: 'update', path: buildWikiPath(subject.slug, finding.pageSlug), content: fixMissingFrontmatter(finding.pageSlug, doc, now) });
    }
    if (entries.length > 0) {
      const changeset = createChangeset(job.id, subject, entries);
      const validation = validateChangeset(changeset);
      if (validation.valid) {
        await applyChangeset(changeset);
        deterministicFixed = entries.length;
        emit('fix:deterministic', `Fixed ${entries.length} frontmatter issue(s).`, { fixed: entries.length });
      } else {
        emit('fix:warn', `Frontmatter fixes failed validation: ${validation.errors.join('; ')}`, { errors: validation.errors });
      }
    }
  }

  // 3. tool-loop：修 broken-link / missing-crossref / contradiction
  let update = 0;
  let create = 0;
  let blockedWriteSlugs: ReadonlySet<string> = EMPTY_SLUGS;
  if (loop.length > 0) {
    const writeCap = Math.max(20, new Set(loop.map((f) => f.pageSlug)).size * 2);
    const guard = createFixGuard({ caps: { writes: writeCap } });
    const baseContext = buildFixToolContext(subject, { guard, jobId: job.id, emit });
    let toolContext = baseContext;
    if (remediationContext) {
      const scoped = scopeFixWrites(baseContext, fixWritableSlugs(worklist), emit);
      toolContext = scoped.context;
      blockedWriteSlugs = scoped.blockedSlugs;
    }
    const profile = resolveToolProfile(
      loop.some((finding) => finding.type === 'contradiction') ? 'fix:contradiction' : 'fix:links',
    );
    const tools = compileToolSet(createBuiltinToolRegistry().resolve([...profile.tools]), toolContext, {
      policy: createToolExecutionPolicy(profile, subject.id, {
        jobCapability: { jobId: job.id, jobType: job.type },
      }),
    });

    const reportLines = buildSubjectReportLines(loop);
    const roster = pagesRepo
      .getAllPages(subject.id)
      .filter((p) => !pagesRepo.isMetaPage(p))
      .map((p) => ({ slug: p.slug, title: p.title }));
    const promptCtx = {
      language: getWikiLanguage(),
      subject: { slug: subject.slug, name: subject.name, description: subject.description },
    };

    emit('fix:agent:start', `Analyzing ${loop.length} finding(s) across ${new Set(loop.map((f) => f.pageSlug)).size} page(s) with the model…`, {
      findings: loop.length,
    });

    await generateTextWithTools('fix', {
      system: buildFixAgenticSystemPrompt(profile.id === 'fix:contradiction'),
      messages: [{ role: 'user', content: buildFixAgenticUserPrompt(reportLines, roster, promptCtx) }],
      tools,
      maxSteps: FIX_MAX_STEPS,
      usageSubjectId: subject.id,
      shouldCancel: () => queue.isCancelRequested(job.id),
      onToolCall: (info) => emit('fix:tool', toolActivityLine(info.tool, info.args), { tool: info.tool }),
    });

    const totals = guard.totals();
    update = totals.update;
    create = totals.create;
  }

  const writes = deterministicFixed + update + create;
  if (writes > 0) enqueueEmbedIndex(subject.id);

  const postcondition = await verifyJobPostconditions({
    kind: 'fix',
    job,
    subject,
    semanticFindings: selectedScope.semantic,
    emit,
  });
  const perFindingOutcomes = buildPerFindingOutcomes(
    worklist,
    postcondition,
    blockedWriteSlugs.size > 0,
  );
  if (remediationContext) {
    for (const findingId of remediationContext.findingIds) {
      if (!hasOwn(perFindingOutcomes, findingId)) {
        perFindingOutcomes[findingId] = postcondition.verificationError === null
          ? 'skipped'
          : 'failed';
      }
    }
  }
  const completeData = {
    deterministic: deterministicFixed,
    update,
    create,
    writes,
    postconditionStatus: postcondition.status,
    residualCount: postcondition.residualFindings.length,
    semanticStatus: postcondition.semanticStatus,
    perFindingOutcomes,
    postcondition,
  };
  const verificationText = postcondition.status === 'clean'
    ? 'Postcondition clean.'
    : `Postcondition residual: ${postcondition.residualFindings.length} issue(s).`;
  emit(
    'fix:complete',
    `Fix complete: ${deterministicFixed} frontmatter, ${update} edited, ${create} created. ${verificationText}`,
    completeData,
  );
  return completeData;
}

registerHandler('fix', runFixJob);
