import type {
  Job,
  LintFinding,
  PostconditionFinding,
  PostconditionReport,
  PostconditionScope,
  Subject,
  SubjectId,
} from '@/lib/contracts';
import * as queue from '../jobs/queue';
import { collectPostconditionScope } from './operation-scope-collector';
import { verifyDeterministicPostconditions } from './postcondition-verifier';
import { recheckFixSemanticPostconditions } from './fix-semantic-postcondition';

type PostconditionKind = 'fix' | 'curate';
type Emit = (
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

function emptyPostconditionScope(
  jobId: string,
  subjectId: SubjectId,
): PostconditionScope {
  return {
    jobId,
    subjectId,
    createdSlugs: [],
    updatedSlugs: [],
    deletedSlugs: [],
    touchedSlugs: [],
    operationIds: [],
  };
}

function stableFindings(findings: PostconditionFinding[]): PostconditionFinding[] {
  const unique = new Map<string, PostconditionFinding>();
  for (const finding of findings) {
    const key = `${finding.type}\0${finding.pageSlug ?? ''}\0${finding.description}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, finding]) => finding);
}

function emitComplete(
  kind: PostconditionKind,
  emit: Emit,
  report: PostconditionReport,
): void {
  const residualCount = report.residualFindings.length;
  const message = report.status === 'clean'
    ? '后置校验通过，未发现残留问题。'
    : `后置校验发现 ${residualCount} 个残留问题。`;
  emit(`${kind}:verify:complete`, message, {
    postconditionStatus: report.status,
    residualCount,
    semanticStatus: report.semanticStatus,
    postcondition: report,
  });
}

/**
 * Fix / Curate 共享写后校验编排器。
 * 已提交写入之后的校验异常只降级为 residual，避免 worker 重放写操作。
 */
export async function verifyJobPostconditions(input: {
  kind: PostconditionKind;
  job: Job;
  subject: Subject;
  semanticFindings?: LintFinding[];
  emit: Emit;
  now?: () => Date;
}): Promise<PostconditionReport> {
  const now = input.now ?? (() => new Date());
  input.emit(
    `${input.kind}:verify:start`,
    '正在校验本次实际写入结果。',
    { jobId: input.job.id, subjectId: input.subject.id },
  );

  let scope: PostconditionScope | null = null;
  try {
    scope = collectPostconditionScope(input.job.id, input.subject);
    if (scope.operationIds.length === 0) {
      const report: PostconditionReport = {
        status: 'clean',
        checkedAt: now().toISOString(),
        scope,
        residualFindings: [],
        semanticStatus: 'not-needed',
        verificationError: null,
      };
      emitComplete(input.kind, input.emit, report);
      return report;
    }

    const deterministicFindings = verifyDeterministicPostconditions(
      input.subject,
      scope,
    );
    let semanticStatus: PostconditionReport['semanticStatus'] = 'not-needed';
    let semanticFindings: PostconditionFinding[] = [];
    let verificationError: string | null = null;

    if (
      input.kind === 'fix' &&
      input.semanticFindings &&
      input.semanticFindings.length > 0
    ) {
      const semantic = await recheckFixSemanticPostconditions({
        subject: input.subject,
        scope,
        findings: input.semanticFindings,
        shouldCancel: () => queue.isCancelRequested(input.job.id),
      });
      semanticStatus = semantic.status;
      semanticFindings = semantic.residualFindings;
      verificationError = semantic.error;
    }

    const residualFindings = stableFindings([
      ...deterministicFindings,
      ...semanticFindings,
    ]);
    const report: PostconditionReport = {
      status:
        residualFindings.length > 0 || verificationError !== null
          ? 'residual'
          : 'clean',
      checkedAt: now().toISOString(),
      scope,
      residualFindings,
      semanticStatus,
      verificationError,
    };
    emitComplete(input.kind, input.emit, report);
    return report;
  } catch (error) {
    console.warn(`[${input.kind}-postcondition] 后置校验失败`, error);
    const report: PostconditionReport = {
      status: 'residual',
      checkedAt: now().toISOString(),
      scope: scope ?? emptyPostconditionScope(input.job.id, input.subject.id),
      residualFindings: [
        {
          type: 'verification-error',
          severity: 'warning',
          pageSlug: null,
          description: '后置校验未能完整执行，请检查 Job 详情并人工复核。',
        },
      ],
      semanticStatus: 'not-needed',
      verificationError: '后置校验未能完整执行。',
    };
    emitComplete(input.kind, input.emit, report);
    return report;
  }
}
