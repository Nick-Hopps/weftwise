import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrichedLintFinding, Job } from '@/lib/contracts';

const queueMock = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/server/jobs/queue', () => queueMock);

import {
  LintVerificationError,
  reconcileVerificationFindings,
  resolveLintVerificationContext,
} from '../lint-verification';
import { selectLatestFindings } from '../lint-latest';

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: 'lint',
    status: 'completed',
    subjectId: 'subject-1',
    paramsJson: '{}',
    resultJson: JSON.stringify({ findings: [] }),
    createdAt: '2026-07-15T00:00:00.000Z',
    startedAt: '2026-07-15T00:00:01.000Z',
    completedAt: '2026-07-15T00:01:00.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 1,
    ...over,
  };
}

function finding(
  id: string,
  type: EnrichedLintFinding['type'],
): EnrichedLintFinding {
  return {
    id,
    subjectId: 'subject-1',
    subjectSlug: 'general',
    type,
    severity: 'warning',
    pageSlug: `page-${id}`,
    description: `finding ${id}`,
    suggestedFix: null,
  };
}

function remediation(
  id: string,
  lintJobId: string,
  findingIds: string[],
  outcomes: Record<string, 'fixed' | 'failed' | 'skipped'>,
): Job {
  return job({
    id,
    type: 'fix',
    paramsJson: JSON.stringify({
      subjectId: 'subject-1',
      remediationContext: { lintJobId, findingIds, action: 'fix' },
    }),
    resultJson: JSON.stringify({ perFindingOutcomes: outcomes }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconcileVerificationFindings', () => {
  it('只移除确认 fixed 的基线语义 finding，并允许新鲜确定性 finding 进入', () => {
    const contradiction = finding('contradiction', 'contradiction');
    const missingCrossref = finding('missing-crossref', 'missing-crossref');
    const coverageGap = finding('coverage-gap', 'coverage-gap');
    const freshOrphan = finding('fresh-orphan', 'orphan');
    const jobs = [
      remediation('fix-1', 'lint-1', [contradiction.id, missingCrossref.id], {
        [contradiction.id]: 'fixed',
        [missingCrossref.id]: 'failed',
      }),
      remediation('fix-2', 'lint-1', [coverageGap.id], {
        [coverageGap.id]: 'fixed',
      }),
    ];

    expect(reconcileVerificationFindings(
      [contradiction, missingCrossref, coverageGap, finding('old-orphan', 'orphan')],
      [freshOrphan],
      jobs,
    )).toEqual([freshOrphan, missingCrossref]);
  });

  it('处置结果损坏时保守保留原语义 finding，并拒绝验证输入夹带新语义 finding', () => {
    const baseline = finding('baseline', 'contradiction');
    const discovered = finding('new-discovery', 'coverage-gap');
    const brokenResult = remediation('fix-1', 'lint-1', [baseline.id], {
      [baseline.id]: 'fixed',
    });
    brokenResult.resultJson = '{';

    expect(reconcileVerificationFindings(
      [baseline],
      [finding('deterministic', 'broken-link'), discovered],
      [brokenResult],
    ).map((item) => item.id)).toEqual(['deterministic', 'baseline']);
  });
});

describe('resolveLintVerificationContext', () => {
  it('校验目标 job 关联，并聚合同一 baseline 的已完成 Fix/Curate', () => {
    const baselineJob = job({
      id: 'lint-1',
      resultJson: JSON.stringify({
        findings: [{
          type: 'orphan',
          severity: 'info',
          pageSlug: 'orphan-page',
          description: 'orphan',
          suggestedFix: null,
          subjectId: 'subject-1',
          subjectSlug: 'general',
        }],
      }),
    });
    const baselineFinding = selectLatestFindings([baselineJob]).findings[0]!;
    const fix = remediation('fix-1', baselineJob.id, [baselineFinding.id], {
      [baselineFinding.id]: 'fixed',
    });
    const curate = job({
      id: 'curate-1',
      type: 'curate',
      paramsJson: JSON.stringify({
        remediationContext: {
          lintJobId: baselineJob.id,
          findingIds: [baselineFinding.id],
          action: 'curate',
        },
      }),
    });
    queueMock.get.mockImplementation((id: string) => (
      id === baselineJob.id ? baselineJob : id === fix.id ? fix : null
    ));
    queueMock.list.mockReturnValue([fix, curate]);

    const resolved = resolveLintVerificationContext('subject-1', {
      baselineLintJobId: baselineJob.id,
      remediationJobId: fix.id,
    });

    expect(resolved.baseline.jobId).toBe(baselineJob.id);
    expect(resolved.remediationJobs.map((item) => item.id)).toEqual(['fix-1', 'curate-1']);
  });

  it('拒绝不属于 baseline 的 remediation', () => {
    const baselineJob = job({ id: 'lint-1' });
    const fix = remediation('fix-1', 'lint-other', [], {});
    queueMock.get.mockImplementation((id: string) => (
      id === baselineJob.id ? baselineJob : fix
    ));

    expect(() => resolveLintVerificationContext('subject-1', {
      baselineLintJobId: baselineJob.id,
      remediationJobId: fix.id,
    })).toThrowError(LintVerificationError);
  });
});
