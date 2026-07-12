import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { Job, RemediationContext } from '@/lib/contracts';
import { MAX_REMEDIATION_JOBS } from '@/server/services/remediation-status';

const mockAuth = vi.fn();
const mockListLatestCompletedLint = vi.fn();
const mockListRecent = vi.fn();
const mockResolve = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: (...args: unknown[]) => mockAuth(...args),
}));
vi.mock('@/server/jobs/queue', () => ({
  listLatestCompletedLint: (...args: unknown[]) => mockListLatestCompletedLint(...args),
  listRecent: (...args: unknown[]) => mockListRecent(...args),
}));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...args: unknown[]) => mockResolve(...args),
}));

import { GET } from '../route';

const SUBJECT_ONE_FINDING_ID = 'edad80746d1269f205fb92b2925ff1479057b336ea7c17915e7374f62a297133';
const SUBJECT_TWO_FINDING_ID = 'fac9b0cfcfc6f3b1516c5d9ee0e6cfa8361cb08e061c1f010f50b01ba20b199e';
const LINT_RAN_AT = '2026-07-13T12:00:00.000Z';
const BEFORE_LINT = '2026-07-13T11:00:00.000Z';

function call(query = '') {
  return GET(new NextRequest(`http://localhost/api/lint/latest${query}`));
}

function job(overrides: Partial<Job> & { id: string }): Job {
  const { id, ...rest } = overrides;
  return {
    id,
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    paramsJson: '{}',
    resultJson: JSON.stringify({ findings: [] }),
    createdAt: '2026-07-13T10:00:00.000Z',
    startedAt: '2026-07-13T10:00:01.000Z',
    completedAt: LINT_RAN_AT,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 1,
    ...rest,
  };
}

function lintJob(
  id: string,
  subjectId: string | null,
  findings: Array<Record<string, unknown>>,
  overrides: Partial<Job> = {},
): Job {
  return job({
    id,
    subjectId,
    resultJson: JSON.stringify({ findings }),
    ...overrides,
  });
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    type: 'broken-link',
    severity: 'warning',
    pageSlug: 'page-a',
    description: 'Broken link to B',
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
    ...overrides,
  };
}

function remediationJob(
  id: string,
  subjectId: string,
  findingIds: string[],
  overrides: Partial<Job> & { action?: RemediationContext['action'] } = {},
): Job {
  const action = overrides.action ?? 'fix';
  return job({
    id,
    type: action === 're-ingest' ? 'ingest' : action,
    status: 'pending',
    subjectId,
    completedAt: null,
    paramsJson: JSON.stringify({
      remediationContext: {
        lintJobId: 'lint-previous',
        findingIds,
        action,
      } satisfies RemediationContext,
    }),
    resultJson: null,
    ...overrides,
  });
}

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockReturnValue(null);
  mockListLatestCompletedLint.mockReset();
  mockListRecent.mockReset();
  mockResolve.mockReset();
});

describe('GET /api/lint/latest', () => {
  it('subject-scoped 返回完整处置计划、当前状态与近期结果', async () => {
    const lint = lintJob('lint-created-early-completed-late', 's1', [finding()], {
      createdAt: '2026-07-13T09:00:00.000Z',
      completedAt: LINT_RAN_AT,
    });
    const createdLaterCompletedEarly = lintJob(
      'lint-created-late-completed-early',
      's1',
      [],
      {
        createdAt: '2026-07-13T11:00:00.000Z',
        completedAt: '2026-07-13T10:00:00.000Z',
      },
    );
    const queuedFix = remediationJob('fix-current', 's1', [SUBJECT_ONE_FINDING_ID]);
    const resolvedFix = remediationJob('fix-resolved', 's1', ['resolved-finding'], {
      status: 'completed',
      completedAt: BEFORE_LINT,
      resultJson: JSON.stringify({
        writes: 1,
        postconditionStatus: 'clean',
        semanticStatus: 'not-needed',
      }),
    });
    mockResolve.mockReturnValue({
      subject: { id: 's1', slug: 'general' },
      error: null,
    });
    mockListLatestCompletedLint.mockReturnValue(lint);
    mockListRecent.mockReturnValue([
      createdLaterCompletedEarly,
      queuedFix,
      resolvedFix,
    ]);

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAuth).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockListLatestCompletedLint).toHaveBeenCalledWith('s1');
    expect(mockListLatestCompletedLint).toHaveBeenCalledTimes(1);
    expect(mockListRecent).toHaveBeenCalledWith(
      { subjectId: 's1' },
      MAX_REMEDIATION_JOBS,
    );
    expect(mockListRecent).toHaveBeenCalledTimes(1);
    expect(body).toEqual({
      jobId: 'lint-created-early-completed-late',
      ranAt: LINT_RAN_AT,
      bySeverity: { critical: 0, warning: 1, info: 0 },
      findings: [
        expect.objectContaining({
          id: SUBJECT_ONE_FINDING_ID,
          subjectId: 's1',
          subjectSlug: 'general',
          type: 'broken-link',
        }),
      ],
      remediations: {
        [SUBJECT_ONE_FINDING_ID]: expect.objectContaining({
          findingId: SUBJECT_ONE_FINDING_ID,
          workflow: 'fix',
          status: 'queued',
          actions: [{ type: 'fix', label: 'Fix issue', destructive: false }],
          jobId: 'fix-current',
        }),
      },
      recentOutcomes: { 'resolved-finding': 'fixed' },
    });
  });

  it('allSubjects=1 只读返回全量 lint，并保留跨 subject 状态键语义', async () => {
    const globalLint = lintJob('lint-global', null, [
      finding(),
      finding({
        type: 'orphan',
        pageSlug: 'page-b',
        description: 'Orphan page',
        subjectId: 's2',
        subjectSlug: 'notes',
      }),
    ]);
    const statusJobs = [
      remediationJob('subject-one-current', 's1', [SUBJECT_ONE_FINDING_ID]),
      remediationJob('subject-two-current', 's2', [SUBJECT_TWO_FINDING_ID], {
        status: 'failed',
        completedAt: BEFORE_LINT,
      }),
      remediationJob('subject-one-resolved', 's1', ['shared-resolved'], {
        status: 'completed',
        completedAt: BEFORE_LINT,
        resultJson: JSON.stringify({
          writes: 1,
          postconditionStatus: 'clean',
          semanticStatus: 'not-needed',
        }),
      }),
      remediationJob('subject-two-resolved', 's2', ['shared-resolved'], {
        status: 'failed',
        completedAt: BEFORE_LINT,
      }),
    ];
    mockListLatestCompletedLint.mockReturnValue(globalLint);
    mockListRecent.mockReturnValue(statusJobs);

    const response = await call('?allSubjects=1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockListLatestCompletedLint).toHaveBeenCalledWith(null);
    expect(mockListLatestCompletedLint).toHaveBeenCalledTimes(1);
    expect(mockListRecent).toHaveBeenCalledWith(
      undefined,
      MAX_REMEDIATION_JOBS,
    );
    expect(mockListRecent).toHaveBeenCalledTimes(1);
    expect(body.jobId).toBe('lint-global');
    expect(body.findings.map((item: { id: string }) => item.id)).toEqual([
      SUBJECT_ONE_FINDING_ID,
      SUBJECT_TWO_FINDING_ID,
    ]);
    expect(body.remediations[SUBJECT_ONE_FINDING_ID]).toMatchObject({
      workflow: 'fix',
      status: 'queued',
      actions: [],
      jobId: 'subject-one-current',
    });
    expect(body.remediations[SUBJECT_TWO_FINDING_ID]).toMatchObject({
      workflow: 'curate',
      status: 'failed',
      actions: [],
      jobId: 'subject-two-current',
    });
    expect(body.recentOutcomes).toEqual({
      [JSON.stringify(['s1', 'shared-resolved'])]: 'fixed',
      [JSON.stringify(['s2', 'shared-resolved'])]: 'failed',
    });
  });

  it('无 lint 时返回完整空 HealthSnapshot', async () => {
    mockResolve.mockReturnValue({
      subject: { id: 's1', slug: 'general' },
      error: null,
    });
    mockListLatestCompletedLint.mockReturnValue(null);
    mockListRecent.mockReturnValue([]);

    const response = await call();

    await expect(response.json()).resolves.toEqual({
      jobId: null,
      ranAt: null,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      findings: [],
      remediations: {},
      recentOutcomes: {},
    });
    expect(mockListLatestCompletedLint).toHaveBeenCalledWith('s1');
    expect(mockListRecent).toHaveBeenCalledWith(
      { subjectId: 's1' },
      MAX_REMEDIATION_JOBS,
    );
    expect(mockListRecent).toHaveBeenCalledTimes(1);
  });

  it('鉴权失败时直接返回且不解析 subject、不查询 jobs', async () => {
    mockAuth.mockReturnValue(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    );

    const response = await call();

    expect(response.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockListLatestCompletedLint).not.toHaveBeenCalled();
    expect(mockListRecent).not.toHaveBeenCalled();
  });

  it('subject 解析失败时直接返回且不查询 jobs', async () => {
    mockResolve.mockReturnValue({
      subject: null,
      error: NextResponse.json({ error: 'subject-not-found' }, { status: 404 }),
    });

    const response = await call();

    expect(response.status).toBe(404);
    expect(mockAuth).toHaveBeenCalledTimes(1);
    expect(mockListLatestCompletedLint).not.toHaveBeenCalled();
    expect(mockListRecent).not.toHaveBeenCalled();
  });
});
