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
import { fixMissingFrontmatter, partitionFindings, buildFixWorklist, buildSubjectReportLines, createFixGuard } from './fix-deterministic';
import { buildFixToolContext } from './fix-tools';
import { readPageInSubject } from '../wiki/wiki-store';
import { buildWikiPath } from '../wiki/page-identity';
import { createChangeset, validateChangeset, applyChangeset } from '../wiki/wiki-transaction';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import { createToolExecutionPolicy, resolveToolProfile } from '@/server/agents/tools/profiles';
import { generateTextWithTools } from '../llm/provider-registry';
import { FIX_AGENTIC_SYSTEM_PROMPT, buildFixAgenticUserPrompt } from '../llm/prompts/fix-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import { toolActivityLine } from '@/lib/tool-activity';
import type {
  ChangesetEntry,
  EnrichedLintFinding,
  Job,
  LintFinding,
  LintLatestResult,
  RemediationContext,
} from '@/lib/contracts';
import { verifyJobPostconditions } from './postcondition-service';

/** 工具循环最大步数（bound 读取轮次；写次数由 FixGuard cap 真正兜底）。 */
export const FIX_MAX_STEPS = 60;

interface FixParams {
  subjectId?: string;
  remediationContext?: RemediationContext;
}

const FIX_TYPES = new Set<LintFinding['type']>([
  'missing-frontmatter',
  'broken-link',
  'missing-crossref',
  'contradiction',
]);

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

function selectedFixFindings(
  freshDeterministic: EnrichedLintFinding[],
  snapshot: LintLatestResult,
  context?: RemediationContext,
): {
  deterministic: EnrichedLintFinding[];
  semantic: EnrichedLintFinding[];
} {
  const snapshotSemantic = snapshot.findings.filter(
    (finding) => finding.type === 'missing-crossref' || finding.type === 'contradiction',
  );
  if (!context) {
    return { deterministic: freshDeterministic, semantic: snapshotSemantic };
  }

  const requested = new Set(context.findingIds);
  const snapshotMatches = snapshot.findings.filter((finding) => requested.has(finding.id));
  if (snapshotMatches.length !== requested.size) {
    throw new Error('Fix finding scope is stale');
  }
  if (snapshotMatches.some((finding) => !FIX_TYPES.has(finding.type))) {
    throw new Error('Fix remediation contains a non-fix finding');
  }

  return {
    deterministic: freshDeterministic.filter((finding) => requested.has(finding.id)),
    semantic: snapshotSemantic.filter((finding) => requested.has(finding.id)),
  };
}

export async function runFixJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as FixParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('fix job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);
  const remediationContext = params.remediationContext;
  if (remediationContext && remediationContext.action !== 'fix') {
    throw new Error('Fix remediation action mismatch');
  }

  // 1. 工作清单：确定性新鲜重扫 + 快照语义
  const snapshot = lintSnapshotForFix(subject.id, remediationContext);
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
  const selected = selectedFixFindings(
    freshDeterministic,
    snapshot,
    remediationContext,
  );

  const worklist = buildFixWorklist(selected.deterministic, selected.semantic);
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
  if (loop.length > 0) {
    const writeCap = Math.max(20, new Set(loop.map((f) => f.pageSlug)).size * 2);
    const guard = createFixGuard({ caps: { writes: writeCap } });
    const ctx = buildFixToolContext(subject, { guard, jobId: job.id, emit });
    const profile = resolveToolProfile(
      loop.some((finding) => finding.type === 'contradiction') ? 'fix:contradiction' : 'fix:links',
    );
    const tools = compileToolSet(createBuiltinToolRegistry().resolve([...profile.tools]), ctx, {
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
      system: FIX_AGENTIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildFixAgenticUserPrompt(reportLines, roster, promptCtx) }],
      tools,
      maxSteps: FIX_MAX_STEPS,
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
    semanticFindings: selected.semantic,
    emit,
  });
  const completeData = {
    deterministic: deterministicFixed,
    update,
    create,
    writes,
    postconditionStatus: postcondition.status,
    residualCount: postcondition.residualFindings.length,
    semanticStatus: postcondition.semanticStatus,
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
