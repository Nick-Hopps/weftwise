import { describe, expect, it } from 'vitest';
import type {
  EnrichedLintFinding,
  Job,
  LintLatestResult,
  RemediationContext,
} from '@/lib/contracts';
import {
  buildHealthSnapshot,
  MAX_REMEDIATION_JOBS,
} from '../remediation-status';

const LINT_RAN_AT = '2026-07-13T12:00:00.000Z';
const BEFORE_LINT = '2026-07-13T11:59:00.000Z';
const AFTER_LINT = '2026-07-13T12:01:00.000Z';

function finding(
  id: string,
  overrides: Partial<EnrichedLintFinding> = {},
): EnrichedLintFinding {
  return {
    id,
    subjectId: 'subject-1',
    subjectSlug: 'general',
    type: 'broken-link',
    severity: 'warning',
    pageSlug: `${id}-page`,
    description: `${id} description`,
    suggestedFix: null,
    ...overrides,
  };
}

function lint(
  findings: EnrichedLintFinding[],
  overrides: Partial<LintLatestResult> = {},
): LintLatestResult {
  return {
    jobId: 'lint-current',
    ranAt: LINT_RAN_AT,
    bySeverity: {
      critical: findings.filter((item) => item.severity === 'critical').length,
      warning: findings.filter((item) => item.severity === 'warning').length,
      info: findings.filter((item) => item.severity === 'info').length,
    },
    findings,
    ...overrides,
  };
}

function job(overrides: Partial<Job> & { id: string }): Job {
  const action = overrides.type === 'curate'
    ? 'curate'
    : overrides.type === 'research'
      ? 'research'
      : overrides.type === 'ingest'
        ? 're-ingest'
        : 'fix';
  const context: RemediationContext = {
    lintJobId: 'lint-previous',
    findingIds: [overrides.id],
    action,
  };

  return {
    type: 'fix',
    status: 'pending',
    subjectId: 'subject-1',
    paramsJson: JSON.stringify({ remediationContext: context }),
    resultJson: null,
    createdAt: BEFORE_LINT,
    startedAt: null,
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

function remediationJob(
  id: string,
  findingIds: string[],
  overrides: Partial<Job> & { action?: RemediationContext['action'] } = {},
): Job {
  const action = overrides.action ?? 'fix';
  const type = action === 're-ingest' ? 'ingest' : action;
  return job({
    id,
    type,
    paramsJson: JSON.stringify({
      remediationContext: {
        lintJobId: 'lint-previous',
        findingIds,
        action,
      } satisfies RemediationContext,
    }),
    ...overrides,
  });
}

const cleanResult = (writes: number, semanticStatus = 'not-needed') =>
  JSON.stringify({
    writes,
    postconditionStatus: 'clean',
    semanticStatus,
  });

describe('buildHealthSnapshot', () => {
  it('无关联 job 时保留 router 初始状态，readOnly 只清空动作', () => {
    const current = lint([
      finding('awaiting'),
      finding('skipped', { type: 'stale-source' }),
    ]);

    const writable = buildHealthSnapshot(current, []);
    const readOnly = buildHealthSnapshot(current, [], { readOnly: true });

    expect(writable.remediations.awaiting).toMatchObject({
      workflow: 'fix',
      status: 'awaiting-approval',
      actions: [{ type: 'fix' }],
    });
    expect(writable.remediations.skipped).toMatchObject({
      workflow: 'source-review',
      status: 'skipped',
      actions: [],
    });
    expect(readOnly.remediations.awaiting).toMatchObject({
      status: 'awaiting-approval',
      actions: [],
    });
    expect(readOnly.recentOutcomes).toEqual({});
  });

  it.each([
    ['pending', 'queued'],
    ['running', 'queued'],
    ['failed', 'failed'],
  ] as const)('%s job 映射为 %s 并写入 jobId', (jobStatus, expectedStatus) => {
    const current = lint([finding('finding-1')]);
    const related = remediationJob('job-1', ['finding-1'], {
      status: jobStatus,
      completedAt: jobStatus === 'failed' ? BEFORE_LINT : null,
    });

    expect(buildHealthSnapshot(current, [related]).remediations['finding-1'])
      .toMatchObject({ status: expectedStatus, jobId: 'job-1' });
  });

  it.each([
    ['lint 尚未运行', null, BEFORE_LINT],
    ['job 无 completedAt', LINT_RAN_AT, null],
    ['job 晚于 lint', LINT_RAN_AT, AFTER_LINT],
  ])('completed 非 research 在%s时保持 queued', (_name, ranAt, completedAt) => {
    const current = lint([finding('finding-1')], { ranAt });
    const related = remediationJob('job-1', ['finding-1'], {
      status: 'completed',
      completedAt,
      resultJson: cleanResult(1),
    });

    expect(buildHealthSnapshot(current, [related]).remediations['finding-1'])
      .toMatchObject({ status: 'queued', jobId: 'job-1' });
  });

  it.each([
    ['非空 candidates', JSON.stringify({ candidates: [{ url: 'https://example.com' }] }), 'awaiting-approval'],
    ['空 candidates', JSON.stringify({ candidates: [] }), 'skipped'],
    ['缺失 candidates', JSON.stringify({ topics: ['topic'] }), 'skipped'],
    ['损坏结果', '{', 'skipped'],
  ] as const)('completed research 的%s立即映射为 %s', (_name, resultJson, status) => {
    const current = lint([finding('finding-1', { type: 'coverage-gap' })]);
    const related = remediationJob('job-1', ['finding-1'], {
      action: 'research',
      status: 'completed',
      completedAt: AFTER_LINT,
      resultJson,
    });

    expect(buildHealthSnapshot(current, [related]).remediations['finding-1'])
      .toMatchObject({ status, jobId: 'job-1' });
  });

  it('更新 lint 后 finding 仍存在时仅可信 writes=0 跳过，其余完成结果失败', () => {
    const current = lint([
      finding('zero-writes'),
      finding('written'),
      finding('residual', { type: 'orphan' }),
      finding('reingest', { type: 'orphan-source', sourceId: 'source-1' }),
      finding('broken-result'),
    ]);
    const jobs = [
      remediationJob('fix-zero', ['zero-writes'], {
        status: 'completed', completedAt: BEFORE_LINT, resultJson: cleanResult(0),
      }),
      remediationJob('fix-written', ['written'], {
        status: 'completed', completedAt: BEFORE_LINT, resultJson: cleanResult(2),
      }),
      remediationJob('curate-residual', ['residual'], {
        action: 'curate',
        status: 'completed',
        completedAt: BEFORE_LINT,
        resultJson: JSON.stringify({ writes: 1, postconditionStatus: 'residual', semanticStatus: 'residual' }),
      }),
      remediationJob('ingest-done', ['reingest'], {
        action: 're-ingest', status: 'completed', completedAt: BEFORE_LINT, resultJson: '{}',
      }),
      remediationJob('fix-broken', ['broken-result'], {
        status: 'completed', completedAt: BEFORE_LINT, resultJson: '{',
      }),
    ];

    const snapshot = buildHealthSnapshot(current, jobs);

    expect(snapshot.remediations['zero-writes'].status).toBe('skipped');
    expect(snapshot.remediations.written.status).toBe('failed');
    expect(snapshot.remediations.residual.status).toBe('failed');
    expect(snapshot.remediations.reingest.status).toBe('failed');
    expect(snapshot.remediations['broken-result'].status).toBe('failed');
  });

  it('finding 消失后仅根据 lint 前终结的最新 job 生成保守 recentOutcomes', () => {
    const jobs = [
      remediationJob('clean-fix', ['fixed-fix'], {
        status: 'completed', completedAt: BEFORE_LINT, resultJson: cleanResult(1),
      }),
      remediationJob('clean-curate', ['fixed-curate'], {
        action: 'curate', status: 'completed', completedAt: BEFORE_LINT, resultJson: cleanResult(3, 'clean'),
      }),
      remediationJob('zero-fix', ['skipped-fix'], {
        status: 'completed', completedAt: BEFORE_LINT, resultJson: cleanResult(0),
      }),
      remediationJob('residual-fix', ['failed-residual'], {
        status: 'completed', completedAt: BEFORE_LINT,
        resultJson: JSON.stringify({ writes: 1, postconditionStatus: 'residual', semanticStatus: 'not-needed' }),
      }),
      remediationJob('semantic-fix', ['failed-semantic'], {
        status: 'completed', completedAt: BEFORE_LINT,
        resultJson: JSON.stringify({ writes: 1, postconditionStatus: 'clean', semanticStatus: 'failed' }),
      }),
      remediationJob('broken-fix', ['failed-broken'], {
        status: 'completed', completedAt: BEFORE_LINT, resultJson: '{',
      }),
      remediationJob('missing-fields', ['failed-missing'], {
        action: 'curate', status: 'completed', completedAt: BEFORE_LINT, resultJson: JSON.stringify({ writes: 1 }),
      }),
      remediationJob('reingest-done', ['fixed-reingest'], {
        action: 're-ingest', status: 'completed', completedAt: BEFORE_LINT, resultJson: null,
      }),
      remediationJob('failed-job', ['failed-job-finding'], {
        status: 'failed', completedAt: BEFORE_LINT,
      }),
      remediationJob('research-done', ['research-finding'], {
        action: 'research', status: 'completed', completedAt: BEFORE_LINT,
        resultJson: JSON.stringify({ candidates: [{ url: 'https://example.com' }] }),
      }),
      remediationJob('late-job', ['late-finding'], {
        status: 'completed', completedAt: AFTER_LINT, resultJson: cleanResult(1),
      }),
      remediationJob('old-completed', ['latest-pending'], {
        status: 'completed', completedAt: BEFORE_LINT, resultJson: cleanResult(1),
        createdAt: '2026-07-13T10:00:00.000Z',
      }),
      remediationJob('new-pending', ['latest-pending'], {
        status: 'pending', createdAt: '2026-07-13T11:30:00.000Z',
      }),
    ];

    expect(buildHealthSnapshot(lint([]), jobs).recentOutcomes).toEqual({
      'fixed-fix': 'fixed',
      'fixed-curate': 'fixed',
      'skipped-fix': 'skipped',
      'failed-residual': 'failed',
      'failed-semantic': 'failed',
      'failed-broken': 'failed',
      'failed-missing': 'failed',
      'fixed-reingest': 'fixed',
      'failed-job-finding': 'failed',
    });
  });

  it('subject 隔离优先于其他 subject 的同 finding ID 新 job', () => {
    const current = lint([finding('shared-id')]);
    const own = remediationJob('own-running', ['shared-id'], {
      status: 'running',
      createdAt: '2026-07-13T10:00:00.000Z',
    });
    const other = remediationJob('other-failed', ['shared-id'], {
      subjectId: 'subject-2',
      status: 'failed',
      completedAt: BEFORE_LINT,
      createdAt: '2026-07-13T11:00:00.000Z',
    });

    expect(buildHealthSnapshot(current, [own, other]).remediations['shared-id'])
      .toMatchObject({ status: 'queued', jobId: 'own-running' });
  });

  it.each(['{', '{}', JSON.stringify({ remediationContext: { findingIds: ['finding-1'] } })])(
    '损坏或不完整 context %j 被跳过',
    (paramsJson) => {
      const current = lint([finding('finding-1')]);
      const malformed = job({ id: 'bad-context', status: 'failed', paramsJson });

      expect(buildHealthSnapshot(current, [malformed]).remediations['finding-1'])
        .toMatchObject({ status: 'awaiting-approval' });
    },
  );

  it('只扫描稳定排序后的最后 200 条，并以 createdAt/id 选择最新 job', () => {
    expect(MAX_REMEDIATION_JOBS).toBe(200);
    const current = lint([finding('finding-1')]);
    const oldestRelated = remediationJob('old-related', ['finding-1'], {
      status: 'failed',
      createdAt: '2026-07-13T00:00:00.000Z',
      completedAt: BEFORE_LINT,
    });
    const fillers = Array.from({ length: MAX_REMEDIATION_JOBS }, (_, index) =>
      remediationJob(`filler-${String(index).padStart(3, '0')}`, [`other-${index}`], {
        createdAt: new Date(Date.parse('2026-07-13T01:00:00.000Z') + index).toISOString(),
      }),
    );
    const overflow = [oldestRelated, ...fillers];

    expect(buildHealthSnapshot(current, overflow).remediations['finding-1'].status)
      .toBe('awaiting-approval');
    expect(buildHealthSnapshot(current, [...overflow].reverse()))
      .toEqual(buildHealthSnapshot(current, overflow));

    const tied = [
      remediationJob('job-a', ['finding-1'], {
        status: 'failed', createdAt: AFTER_LINT, completedAt: AFTER_LINT,
      }),
      remediationJob('job-z', ['finding-1'], {
        status: 'running', createdAt: AFTER_LINT,
      }),
    ];
    expect(buildHealthSnapshot(current, tied).remediations['finding-1'])
      .toMatchObject({ status: 'queued', jobId: 'job-z' });
    expect(buildHealthSnapshot(current, [...tied].reverse()))
      .toEqual(buildHealthSnapshot(current, tied));
  });

  it('不修改 lint、findings 或 jobs 输入', () => {
    const current = lint([finding('finding-1')]);
    const jobs = [remediationJob('job-1', ['finding-1'], { status: 'running' })];
    const lintBefore = structuredClone(current);
    const jobsBefore = structuredClone(jobs);

    const snapshot = buildHealthSnapshot(current, jobs);

    expect(current).toEqual(lintBefore);
    expect(jobs).toEqual(jobsBefore);
    expect(snapshot).not.toBe(current);
    expect(snapshot.findings).toBe(current.findings);
  });
});
