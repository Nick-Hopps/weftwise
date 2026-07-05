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
import { runDeterministicChecksForSubject } from './lint-deterministic';
import { runSemanticChecksForSubject } from './lint-semantic';
import type { LintFinding, Job, Subject } from '@/lib/contracts';

interface LintParams {
  subjectId?: string;
}

async function runLintJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as LintParams;
  const targetSubjectId = params.subjectId ?? job.subjectId ?? null;

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

  const allFindings: (LintFinding & { subjectId: string; subjectSlug: string })[] = [];
  const semanticFailures: string[] = [];

  for (const subject of targets) {
    emit('lint:deterministic:start', `Subject "${subject.slug}": running deterministic checks...`);
    const deterministicFindings = runDeterministicChecksForSubject(subject);
    allFindings.push(
      ...deterministicFindings.map((f) => ({ ...f, subjectId: subject.id, subjectSlug: subject.slug })),
    );
    emit(
      'lint:deterministic:done',
      `Subject "${subject.slug}": ${deterministicFindings.length} deterministic finding(s)`,
      { findings: deterministicFindings, subject: subject.slug }
    );

    emit('lint:semantic:start', `Subject "${subject.slug}": running LLM semantic analysis...`);
    try {
      const semanticFindings = await runSemanticChecksForSubject(subject);
      allFindings.push(
        ...semanticFindings.map((f) => ({ ...f, subjectId: subject.id, subjectSlug: subject.slug })),
      );
      emit(
        'lint:semantic:done',
        `Subject "${subject.slug}": ${semanticFindings.length} semantic finding(s)`,
        { findings: semanticFindings, subject: subject.slug }
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

  emit(
    'lint:complete',
    `Lint complete: ${allFindings.length} total finding(s)`,
    {
      totalFindings: allFindings.length,
      bySeverity: {
        critical: allFindings.filter((f) => f.severity === 'critical').length,
        warning: allFindings.filter((f) => f.severity === 'warning').length,
        info: allFindings.filter((f) => f.severity === 'info').length,
      },
    },
  );

  return { findings: allFindings };
}

registerHandler('lint', runLintJob);
