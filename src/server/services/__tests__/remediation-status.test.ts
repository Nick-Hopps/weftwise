import { describe, expect, it } from 'vitest';
import type {
  EnrichedLintFinding,
  Job,
  LintLatestResult,
  RemediationContext,
  ResearchRunView,
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

const RESEARCH_CANDIDATE = {
  url: 'https://example.com',
  title: 'Example source',
  snippet: 'Example snippet',
  score: 3,
  reason: 'Relevant evidence',
};

function researchRun(
  status: ResearchRunView['status'],
  overrides: Partial<ResearchRunView> = {},
): ResearchRunView {
  return {
    id: 'run-1',
    subjectId: 'subject-1',
    researchJobId: 'job-1',
    origin: 'findings',
    lintJobId: 'lint-previous',
    topic: null,
    topics: ['topic'],
    queries: ['query'],
    candidateSetHash: 'hash',
    status,
    version: 2,
    verificationLintJobId: status === 'verifying' ? 'lint-verification' : null,
    findings: [{
      findingId: 'finding-1',
      finding: finding('finding-1', { type: 'coverage-gap' }),
      verificationStatus: status === 'completed' ? 'fixed' : 'pending',
      verifiedAt: status === 'completed' ? AFTER_LINT : null,
      verificationFinding: null,
    }],
    candidates: [],
    approval: status === 'awaiting-approval' || status === 'dismissed' || status === 'empty'
      ? null
      : {
          id: 'approval-1',
          selectedCandidateIds: [],
          coordinatorJobId: 'coordinator-1',
          createdAt: BEFORE_LINT,
        },
    createdAt: BEFORE_LINT,
    updatedAt: AFTER_LINT,
    completedAt: ['completed', 'partial', 'failed', 'dismissed', 'empty'].includes(status)
      ? AFTER_LINT
      : null,
    error: status === 'failed' ? { message: 'failed' } : null,
    ...overrides,
  };
}

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
    ['合法非空 candidates', JSON.stringify({ candidates: [RESEARCH_CANDIDATE] }), 'awaiting-approval'],
    ['空 candidates', JSON.stringify({ candidates: [] }), 'skipped'],
    ['缺失 candidates', JSON.stringify({ topics: ['topic'] }), 'failed'],
    ['candidates 非数组', JSON.stringify({ candidates: {} }), 'failed'],
    ['candidate 为 null', JSON.stringify({ candidates: [null] }), 'failed'],
    ['candidate 缺字段', JSON.stringify({ candidates: [{ ...RESEARCH_CANDIDATE, title: undefined }] }), 'failed'],
    ['candidate 字段类型错误', JSON.stringify({ candidates: [{ ...RESEARCH_CANDIDATE, score: '3' }] }), 'failed'],
    ['损坏结果', '{', 'failed'],
  ] as const)('completed research 的%s立即映射到预期状态', (_name, resultJson, status) => {
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

  it.each([
    ['awaiting-approval', 'awaiting-approval'],
    ['importing', 'queued'],
    ['verifying', 'queued'],
    ['dismissed', 'skipped'],
    ['empty', 'skipped'],
  ] as const)('持久化 Research run 的 %s 映射为 %s', (runStatus, expected) => {
    const current = lint([finding('finding-1', { type: 'coverage-gap' })]);
    const related = remediationJob('job-1', ['finding-1'], {
      action: 'research',
      status: 'completed',
      completedAt: AFTER_LINT,
      resultJson: JSON.stringify({ runId: 'run-1' }),
    });

    expect(buildHealthSnapshot(current, [related], {
      researchRuns: [researchRun(runStatus)],
    }).remediations['finding-1']).toMatchObject({ status: expected, jobId: 'job-1' });
  });

  it.each([
    ['completed', 'fixed', 'fixed'],
    ['partial', 'fixed', 'fixed'],
    ['partial', 'residual', 'failed'],
    ['failed', 'unverifiable', 'failed'],
  ] as const)(
    '持久化 Research run 的 %s/%s 使用逐 finding 验证结果 %s',
    (runStatus, verificationStatus, expected) => {
      const current = lint([finding('finding-1', { type: 'coverage-gap' })]);
      const related = remediationJob('job-1', ['finding-1'], {
        action: 'research',
        status: 'completed',
        completedAt: AFTER_LINT,
        resultJson: JSON.stringify({ runId: 'run-1' }),
      });
      const run = researchRun(runStatus, {
        findings: [{
          findingId: 'finding-1',
          finding: finding('finding-1', { type: 'coverage-gap' }),
          verificationStatus,
          verifiedAt: AFTER_LINT,
          verificationFinding: verificationStatus === 'residual'
            ? finding('finding-1', { type: 'coverage-gap' })
            : null,
        }],
      });

      expect(buildHealthSnapshot(current, [related], { researchRuns: [run] })
        .remediations['finding-1'].status).toBe(expected);
    },
  );

  it('Research finding 消失后把已物化 fixed 计入 recent outcome', () => {
    const related = remediationJob('job-1', ['finding-1'], {
      action: 'research',
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify({ runId: 'run-1' }),
    });

    expect(buildHealthSnapshot(lint([]), [related], {
      researchRuns: [researchRun('completed')],
    }).recentOutcomes).toEqual({ 'finding-1': 'fixed' });
  });

  it.each([
    ['null', null, 'awaiting-approval'],
    ['下界 0', 0, 'awaiting-approval'],
    ['上界 3', 3, 'awaiting-approval'],
    ['负数', -1, 'failed'],
    ['小数', 1.5, 'failed'],
    ['超过上界', 4, 'failed'],
  ] as const)('completed research 的 score %s 映射到预期状态', (_name, score, status) => {
    const current = lint([finding('finding-1', { type: 'coverage-gap' })]);
    const related = remediationJob('job-1', ['finding-1'], {
      action: 'research',
      status: 'completed',
      completedAt: AFTER_LINT,
      resultJson: JSON.stringify({
        candidates: [{ ...RESEARCH_CANDIDATE, score }],
      }),
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

  it('批量 Fix 的当前与已消失 finding 分别读取自己的 outcome', () => {
    const current = lint([finding('semantic-residual', { type: 'contradiction' })]);
    const related = remediationJob('partial-fix', ['deterministic-fixed', 'semantic-residual'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify({
        writes: 1,
        postconditionStatus: 'residual',
        semanticStatus: 'residual',
        perFindingOutcomes: {
          'deterministic-fixed': 'fixed',
          'semantic-residual': 'failed',
        },
      }),
    });

    const snapshot = buildHealthSnapshot(current, [related]);

    expect(snapshot.remediations['semantic-residual']).toMatchObject({
      status: 'failed',
      jobId: 'partial-fix',
    });
    expect(snapshot.recentOutcomes).toEqual({ 'deterministic-fixed': 'fixed' });
  });

  it('批量 Curate 的当前与已消失 orphan 分别读取自己的 outcome', () => {
    const current = lint([finding('orphan-residual', { type: 'orphan' })]);
    const related = remediationJob('partial-curate', ['orphan-fixed', 'orphan-residual'], {
      action: 'curate',
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify({
        writes: 1,
        postconditionStatus: 'residual',
        semanticStatus: 'not-needed',
        perFindingOutcomes: {
          'orphan-fixed': 'fixed',
          'orphan-residual': 'failed',
        },
      }),
    });

    const snapshot = buildHealthSnapshot(current, [related]);

    expect(snapshot.remediations['orphan-residual']).toMatchObject({
      status: 'failed',
      jobId: 'partial-curate',
    });
    expect(snapshot.recentOutcomes).toEqual({ 'orphan-fixed': 'fixed' });
  });

  it.each([
    ['容器损坏', []],
    ['自身状态未知', { 'resolved-finding': 'unknown' }],
    ['缺少自身键', { 'other-finding': 'failed' }],
  ])('Fix perFindingOutcomes %s 时回退旧 job-level 结果', (_name, perFindingOutcomes) => {
    const related = remediationJob('legacy-compatible-fix', ['resolved-finding'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify({
        writes: 1,
        postconditionStatus: 'clean',
        semanticStatus: 'not-needed',
        perFindingOutcomes,
      }),
    });

    expect(buildHealthSnapshot(lint([]), [related]).recentOutcomes)
      .toEqual({ 'resolved-finding': 'fixed' });
  });

  it.each([
    ['容器损坏', []],
    ['自身状态未知', { 'resolved-orphan': 'unknown' }],
    ['缺少自身键', { 'other-orphan': 'failed' }],
  ])('Curate perFindingOutcomes %s 时回退旧 job-level 结果', (_name, perFindingOutcomes) => {
    const related = remediationJob('legacy-compatible-curate', ['resolved-orphan'], {
      action: 'curate',
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify({
        writes: 1,
        postconditionStatus: 'clean',
        semanticStatus: 'not-needed',
        perFindingOutcomes,
      }),
    });

    expect(buildHealthSnapshot(lint([]), [related]).recentOutcomes)
      .toEqual({ 'resolved-orphan': 'fixed' });
  });

  it.each([
    ['postcondition residual', { writes: 0, postconditionStatus: 'residual', semanticStatus: 'not-needed' }],
    ['semantic failed', { writes: 0, postconditionStatus: 'clean', semanticStatus: 'failed' }],
    ['semantic residual', { writes: 0, postconditionStatus: 'clean', semanticStatus: 'residual' }],
  ])('当前 finding 的零写入遇到 %s 时优先判为 failed', (_name, result) => {
    const current = lint([finding('finding-1')]);
    const related = remediationJob('job-1', ['finding-1'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify(result),
    });

    expect(buildHealthSnapshot(current, [related]).remediations['finding-1'].status)
      .toBe('failed');
  });

  it.each([
    ['负数', { writes: -1, postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['小数', { writes: 1.5, postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['字符串', { writes: '0', postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['null', { writes: null, postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['缺失', { postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['超过安全整数', { writes: Number.MAX_SAFE_INTEGER + 1, postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
  ])('当前 finding 拒绝%s writes', (_name, result) => {
    const current = lint([finding('finding-1')]);
    const related = remediationJob('job-1', ['finding-1'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify(result),
    });

    expect(buildHealthSnapshot(current, [related]).remediations['finding-1'].status)
      .toBe('failed');
  });

  it.each([
    ['缺失', { writes: 0, postconditionStatus: 'clean' }],
    ['unknown', { writes: 0, postconditionStatus: 'clean', semanticStatus: 'unknown' }],
    ['null', { writes: 0, postconditionStatus: 'clean', semanticStatus: null }],
  ])('当前 finding 的 semanticStatus %s 时零写入也判为 failed', (_name, result) => {
    const current = lint([finding('finding-1')]);
    const related = remediationJob('job-1', ['finding-1'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify(result),
    });

    expect(buildHealthSnapshot(current, [related]).remediations['finding-1'].status)
      .toBe('failed');
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
        resultJson: JSON.stringify({ candidates: [RESEARCH_CANDIDATE] }),
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

  it.each([
    ['postcondition residual', { writes: 0, postconditionStatus: 'residual', semanticStatus: 'not-needed' }],
    ['semantic failed', { writes: 0, postconditionStatus: 'clean', semanticStatus: 'failed' }],
    ['semantic residual', { writes: 0, postconditionStatus: 'clean', semanticStatus: 'residual' }],
  ])('recent outcome 的零写入遇到 %s 时优先判为 failed', (_name, result) => {
    const related = remediationJob('job-1', ['resolved-finding'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify(result),
    });

    expect(buildHealthSnapshot(lint([]), [related]).recentOutcomes)
      .toEqual({ 'resolved-finding': 'failed' });
  });

  it.each([
    ['负数', { writes: -1, postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['小数', { writes: 1.5, postconditionStatus: 'clean', semanticStatus: 'clean' }],
    ['字符串', { writes: '0', postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['null', { writes: null, postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['缺失', { postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
    ['超过安全整数', { writes: Number.MAX_SAFE_INTEGER + 1, postconditionStatus: 'clean', semanticStatus: 'not-needed' }],
  ])('recent outcome 拒绝%s writes', (_name, result) => {
    const related = remediationJob('job-1', ['resolved-finding'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify(result),
    });

    expect(buildHealthSnapshot(lint([]), [related]).recentOutcomes)
      .toEqual({ 'resolved-finding': 'failed' });
  });

  it.each([
    ['缺失', { writes: 0, postconditionStatus: 'clean' }],
    ['unknown', { writes: 0, postconditionStatus: 'clean', semanticStatus: 'unknown' }],
    ['null', { writes: 0, postconditionStatus: 'clean', semanticStatus: null }],
  ])('recent outcome 的 semanticStatus %s 时零写入也判为 failed', (_name, result) => {
    const related = remediationJob('job-1', ['resolved-finding'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify(result),
    });

    expect(buildHealthSnapshot(lint([]), [related]).recentOutcomes)
      .toEqual({ 'resolved-finding': 'failed' });
  });

  it('多 ID context 为每个 finding 各生成一次 recent outcome', () => {
    const findingIds = ['finding-a', 'finding-b', 'finding-c'];
    const related = remediationJob('job-1', findingIds, {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: cleanResult(1),
    });

    expect(buildHealthSnapshot(lint([]), [related]).recentOutcomes).toEqual({
      'finding-a': 'fixed',
      'finding-b': 'fixed',
      'finding-c': 'fixed',
    });
  });

  it('不同 subject 的相同手工 finding ID 不会互相抑制', () => {
    const current = lint([finding('manual-id', { subjectId: 'subject-1' })]);
    const otherSubject = remediationJob('job-other', ['manual-id'], {
      subjectId: 'subject-2',
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: cleanResult(1),
    });

    const snapshot = buildHealthSnapshot(current, [otherSubject]);

    expect(snapshot.remediations['manual-id'].status).toBe('awaiting-approval');
    expect(snapshot.recentOutcomes).toEqual({ 'manual-id': 'fixed' });
  });

  it('recent 同一手工 finding ID 跨 subject 时用复合键保留全部结果且不受输入顺序影响', () => {
    const subjectOne = remediationJob('job-subject-1', ['manual-id'], {
      subjectId: 'subject-1',
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: cleanResult(1),
    });
    const subjectTwo = remediationJob('job-subject-2', ['manual-id'], {
      subjectId: 'subject-2',
      status: 'failed',
      completedAt: BEFORE_LINT,
    });
    const expected = {
      [JSON.stringify(['subject-1', 'manual-id'])]: 'fixed',
      [JSON.stringify(['subject-2', 'manual-id'])]: 'failed',
    };

    expect(buildHealthSnapshot(lint([]), [subjectOne, subjectTwo]).recentOutcomes)
      .toEqual(expected);
    expect(buildHealthSnapshot(lint([]), [subjectTwo, subjectOne]).recentOutcomes)
      .toEqual(expected);
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
