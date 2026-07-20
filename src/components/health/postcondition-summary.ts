import type { PostconditionReport } from '@/lib/contracts';
import type { JobStreamEvent } from '@/hooks/use-job-stream';
import type { TranslationFunction } from '@/lib/i18n/translator';

export interface PostconditionNotice {
  tone: 'success' | 'warning';
  title: string;
  details: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPostconditionReport(value: unknown): value is PostconditionReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  if (!report.scope || typeof report.scope !== 'object') return false;
  const scope = report.scope as Record<string, unknown>;

  return (
    (report.status === 'clean' || report.status === 'residual') &&
    typeof report.checkedAt === 'string' &&
    typeof scope.jobId === 'string' &&
    typeof scope.subjectId === 'string' &&
    isStringArray(scope.createdSlugs) &&
    isStringArray(scope.updatedSlugs) &&
    isStringArray(scope.deletedSlugs) &&
    isStringArray(scope.touchedSlugs) &&
    isStringArray(scope.operationIds) &&
    Array.isArray(report.residualFindings) &&
    ['not-needed', 'clean', 'residual', 'failed'].includes(
      String(report.semanticStatus),
    ) &&
    (report.verificationError === null ||
      typeof report.verificationError === 'string')
  );
}

/** SSE 的业务 data 位于外层 envelope 的 data 字段内。 */
export function extractPostconditionReport(
  event: JobStreamEvent | undefined,
): PostconditionReport | null {
  const nested = event?.data.data;
  if (!nested || typeof nested !== 'object') return null;
  const report = (nested as Record<string, unknown>).postcondition;
  return isPostconditionReport(report) ? report : null;
}

function boundedDetail(value: string): string {
  if (value.length <= 180) return value;
  return `${value.slice(0, 179)}…`;
}

export function buildPostconditionNotice(
  report: PostconditionReport,
  t: TranslationFunction,
): PostconditionNotice {
  if (report.semanticStatus === 'failed') {
    return {
      tone: 'warning',
      title: t('health.postcondition.semanticTitle'),
      details: [
        t('health.postcondition.semanticDetail'),
        ...report.residualFindings
          .slice(0, 2)
          .map((finding) => boundedDetail(finding.description)),
      ],
    };
  }

  if (report.status === 'residual') {
    return {
      tone: 'warning',
      title: t('health.postcondition.residualTitle', { count: report.residualFindings.length }),
      details: report.residualFindings
        .slice(0, 3)
        .map((finding) => boundedDetail(finding.description)),
    };
  }

  return {
    tone: 'success',
    title: t('health.postcondition.cleanTitle'),
    details: [t('health.postcondition.cleanDetail')],
  };
}
