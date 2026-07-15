/**
 * Lint service — two-phase wiki quality audit.
 *
 * Phase 1 (deterministic): broken wikilinks, orphan pages, missing frontmatter,
 *                           stale sources. No LLM required. （实现见 lint-deterministic.ts）
 * Phase 2 (semantic):      contradictions, missing cross-references, coverage
 *                           gaps detected by the LLM. （实现见 lint-semantic.ts）
 *
 * 本文件只负责 handler 注册与两阶段编排；side-effect import 语义不变——
 * worker-entry import 本文件即完成 `registerHandler('lint', ...)`。
 *
 * Lint runs per-subject. A job with `subjectId === null` falls back to scanning
 * every subject; per-subject jobs (the common case) only audit pages within
 * that subject.
 */

import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { resolveTask } from '../llm/task-router';
import { runDeterministicChecksForSubject } from './lint-deterministic';
import { runSemanticChecksForSubject } from './lint-semantic';
import { identifyFindings } from './finding-identity';
import {
  reconcileVerificationFindings,
  resolveLintVerificationContext,
} from './lint-verification';
import type {
  EnrichedLintFinding,
  Job,
  LintFinding,
  LintVerificationRequest,
  Subject,
} from '@/lib/contracts';

interface LintParams {
  subjectId?: string;
  verification?: LintVerificationRequest;
}

/** findings 分类统计（severity/type 计数 + 单行文案），供 lint 事件与 result 附带。 */
export function summarizeFindings(
  findings: Pick<LintFinding, 'severity' | 'type'>[],
): { bySeverity: Record<string, number>; byType: Record<string, number>; text: string } {
  const bySeverity: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byType[f.type] = (byType[f.type] ?? 0) + 1;
  }
  const severityText = ['critical', 'warning', 'info']
    .filter((s) => bySeverity[s])
    .map((s) => `${bySeverity[s]} ${s}`)
    .join(', ');
  const typeText = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t}×${n}`)
    .join(', ');
  return { bySeverity, byType, text: [severityText, typeText].filter(Boolean).join('; ') };
}

function identifySubjectFindings(
  subject: Subject,
  findings: LintFinding[],
): EnrichedLintFinding[] {
  return identifyFindings(
    findings.map((finding) => ({
      ...finding,
      subjectId: subject.id,
      subjectSlug: subject.slug,
    })),
  );
}

/** lint task 的模型标签；配置解析失败时回落 null（不阻断 lint 主流程）。 */
function lintModelLabel(): string | null {
  try {
    return resolveTask('lint').logLabel;
  } catch {
    return null;
  }
}

export async function runLintJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as LintParams;
  const targetSubjectId = params.subjectId ?? job.subjectId ?? null;
  const verification = params.verification && targetSubjectId
    ? resolveLintVerificationContext(targetSubjectId, params.verification)
    : null;

  if (params.verification && !verification) {
    throw new Error('Lint verification requires one subject');
  }

  const targets: Subject[] = targetSubjectId
    ? (() => {
        const found = subjectsRepo.getById(targetSubjectId);
        if (!found) throw new Error(`Subject ${targetSubjectId} not found`);
        return [found];
      })()
    : subjectsRepo.listSubjects();

  emit(
    'lint:scope',
    targetSubjectId
      ? `Linting subject: ${targets[0].slug}`
      : `Linting all ${targets.length} subject(s)`,
    { subjectIds: targets.map((s) => s.id) }
  );

  const allFindings: EnrichedLintFinding[] = [];
  const semanticFailures: string[] = [];

  for (const subject of targets) {
    emit('lint:deterministic:start', `Subject "${subject.slug}": running deterministic checks...`);
    const deterministicFindings = runDeterministicChecksForSubject(subject);
    const identifiedDeterministicFindings = identifySubjectFindings(subject, deterministicFindings);
    emit(
      'lint:deterministic:done',
      `Subject "${subject.slug}": ${identifiedDeterministicFindings.length} deterministic finding(s)`,
      { findings: identifiedDeterministicFindings, subject: subject.slug }
    );

    if (verification) {
      const verifiedFindings = reconcileVerificationFindings(
        verification.baseline.findings,
        identifiedDeterministicFindings,
        verification.remediationJobs,
      );
      allFindings.push(...verifiedFindings);
      const semanticCount = verifiedFindings.filter((finding) => (
        finding.type === 'contradiction'
        || finding.type === 'missing-crossref'
        || finding.type === 'coverage-gap'
      )).length;
      emit(
        'lint:verification:done',
        `Subject "${subject.slug}": verified the existing snapshot without discovering unrelated semantic findings`,
        {
          baselineLintJobId: verification.request.baselineLintJobId,
          remediationJobId: verification.request.remediationJobId,
          deterministicFindings: identifiedDeterministicFindings.length,
          residualSemanticFindings: semanticCount,
        },
      );
      continue;
    }

    allFindings.push(...identifiedDeterministicFindings);
    const pageCount = pagesRepo.getAllPages(subject.id).filter((p) => !pagesRepo.isMetaPage(p)).length;
    const model = lintModelLabel();
    emit(
      'lint:semantic:start',
      `Subject "${subject.slug}": running LLM semantic analysis on ${pageCount} page(s)${model ? ` with ${model}` : ''} (single pass, may take a few minutes)…`,
      { pageCount, model },
    );
    try {
      const semanticFindings = await runSemanticChecksForSubject(subject);
      const identifiedSemanticFindings = identifySubjectFindings(subject, semanticFindings);
      allFindings.push(...identifiedSemanticFindings);
      const semanticStats = summarizeFindings(identifiedSemanticFindings);
      emit(
        'lint:semantic:done',
        `Subject "${subject.slug}": ${identifiedSemanticFindings.length} semantic finding(s)${semanticStats.text ? ` (${semanticStats.text})` : ''}`,
        { findings: identifiedSemanticFindings, subject: subject.slug, ...semanticStats },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      emit('lint:semantic:error', `Subject "${subject.slug}": semantic analysis failed: ${msg}`);
      semanticFailures.push(`${subject.slug}: ${msg}`);
    }
  }

  // 语义阶段失败不能伪装成体检通过：残缺快照会被 fix-service 当可信基线消费。
  // 先 emit 完整过程事件再让 job 失败，前端仍能看到确定性阶段结果。
  if (semanticFailures.length > 0) {
    throw new Error(
      `Semantic lint failed for ${semanticFailures.length} subject(s): ${semanticFailures.join('; ')}`
    );
  }

  const stats = summarizeFindings(allFindings);
  emit(
    'lint:complete',
    `Lint complete: ${allFindings.length} total finding(s)${stats.text ? ` (${stats.text})` : ''}`,
    { totalFindings: allFindings.length, bySeverity: stats.bySeverity, byType: stats.byType },
  );

  return {
    findings: allFindings,
    mode: verification ? 'verification' : 'discovery',
    ...(verification ? {
      baselineLintJobId: verification.request.baselineLintJobId,
      remediationJobId: verification.request.remediationJobId,
    } : {}),
  };
}

registerHandler('lint', runLintJob);
