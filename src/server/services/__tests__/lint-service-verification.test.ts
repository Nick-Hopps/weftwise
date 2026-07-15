import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrichedLintFinding, Job, Subject } from '@/lib/contracts';

const registerMock = vi.hoisted(() => vi.fn());
const subjectsMock = vi.hoisted(() => ({ getById: vi.fn(), listSubjects: vi.fn() }));
const pagesMock = vi.hoisted(() => ({ getAllPages: vi.fn(), isMetaPage: vi.fn() }));
const deterministicMock = vi.hoisted(() => vi.fn());
const semanticMock = vi.hoisted(() => vi.fn());
const verificationMock = vi.hoisted(() => ({
  resolve: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('@/server/jobs/worker', () => ({ registerHandler: registerMock }));
vi.mock('@/server/db/repos/subjects-repo', () => subjectsMock);
vi.mock('@/server/db/repos/pages-repo', () => pagesMock);
vi.mock('@/server/llm/task-router', () => ({ resolveTask: vi.fn() }));
vi.mock('@/server/services/lint-deterministic', () => ({
  runDeterministicChecksForSubject: deterministicMock,
}));
vi.mock('@/server/services/lint-semantic', () => ({
  runSemanticChecksForSubject: semanticMock,
}));
vi.mock('@/server/services/lint-verification', () => ({
  resolveLintVerificationContext: (...args: unknown[]) => verificationMock.resolve(...args),
  reconcileVerificationFindings: (...args: unknown[]) => verificationMock.reconcile(...args),
}));

import { runLintJob } from '../lint-service';

const subject: Subject = {
  id: 'subject-1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
};

const residual: EnrichedLintFinding = {
  id: 'semantic-1',
  subjectId: subject.id,
  subjectSlug: subject.slug,
  type: 'contradiction',
  severity: 'warning',
  pageSlug: 'page-a',
  description: 'residual contradiction',
  suggestedFix: null,
};

function lintJob(): Job {
  return {
    id: 'lint-verification',
    type: 'lint',
    status: 'running',
    subjectId: subject.id,
    paramsJson: JSON.stringify({
      subjectId: subject.id,
      verification: {
        baselineLintJobId: 'lint-origin',
        remediationJobId: 'fix-1',
      },
    }),
    resultJson: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    startedAt: '2026-07-15T00:00:01.000Z',
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  subjectsMock.getById.mockReturnValue(subject);
  pagesMock.getAllPages.mockReturnValue([]);
  pagesMock.isMetaPage.mockReturnValue(false);
  deterministicMock.mockReturnValue([{
    type: 'orphan',
    severity: 'info',
    pageSlug: 'page-b',
    description: 'orphan',
    suggestedFix: null,
  }]);
  verificationMock.resolve.mockReturnValue({
    baseline: { findings: [residual] },
    remediationJobs: [],
    request: { baselineLintJobId: 'lint-origin', remediationJobId: 'fix-1' },
  });
  verificationMock.reconcile.mockReturnValue([residual]);
});

describe('runLintJob verification', () => {
  it('只跑确定性检查与基线协调，不调用开放式语义发现', async () => {
    const emit = vi.fn();
    const result = await runLintJob(lintJob(), emit);

    expect(semanticMock).not.toHaveBeenCalled();
    expect(verificationMock.reconcile).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      findings: [residual],
      mode: 'verification',
      baselineLintJobId: 'lint-origin',
      remediationJobId: 'fix-1',
    });
    expect(emit).toHaveBeenCalledWith(
      'lint:verification:done',
      expect.any(String),
      expect.objectContaining({ residualSemanticFindings: 1 }),
    );
    expect(emit.mock.calls.some(([type]) => type === 'lint:semantic:start')).toBe(false);
  });

  it('语义 schema 失败时写入脱敏诊断，但不把模型原始输出落入事件', async () => {
    const emit = vi.fn();
    const job = {
      ...lintJob(),
      id: 'lint-discovery',
      paramsJson: JSON.stringify({ subjectId: subject.id }),
    };
    const schemaError = Object.assign(
      new Error('No object generated: response did not match schema.'),
      {
        finishReason: 'stop',
        text: 'PRIVATE WIKI CONTENT',
        cause: {
          cause: {
            issues: [{ path: ['findings', 0, 'targetSlug'], message: 'Required' }],
          },
        },
      },
    );
    semanticMock.mockRejectedValue(schemaError);

    await expect(runLintJob(job, emit)).rejects.toThrow('Semantic lint failed');

    expect(emit).toHaveBeenCalledWith(
      'lint:semantic:error',
      expect.stringContaining('response did not match schema'),
      {
        finishReason: 'stop',
        detail: 'findings.0.targetSlug: Required',
      },
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE WIKI CONTENT');
  });
});
