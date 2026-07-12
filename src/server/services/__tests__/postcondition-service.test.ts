import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Job,
  LintFinding,
  PostconditionFinding,
  PostconditionScope,
  Subject,
} from '@/lib/contracts';

const collectMock = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/operation-scope-collector', () => ({
  collectPostconditionScope: collectMock,
}));

const deterministicMock = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/postcondition-verifier', () => ({
  verifyDeterministicPostconditions: deterministicMock,
}));

const semanticMock = vi.hoisted(() => vi.fn());
vi.mock('@/server/services/fix-semantic-postcondition', () => ({
  recheckFixSemanticPostconditions: semanticMock,
}));

import { verifyJobPostconditions } from '../postcondition-service';

const NOW = new Date('2026-07-12T08:00:00.000Z');
const subject: Subject = {
  id: 's1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-07-12T00:00:00.000Z',
  updatedAt: '2026-07-12T00:00:00.000Z',
};
const job = {
  id: 'job-1',
  type: 'fix',
  subjectId: 's1',
  paramsJson: '{}',
  status: 'running',
} as Job;

const appliedScope: PostconditionScope = {
  jobId: 'job-1',
  subjectId: 's1',
  createdSlugs: [],
  updatedSlugs: ['a'],
  deletedSlugs: [],
  touchedSlugs: ['a'],
  operationIds: ['op-1'],
};
const emptyScope: PostconditionScope = {
  ...appliedScope,
  updatedSlugs: [],
  touchedSlugs: [],
  operationIds: [],
};
const brokenLink: PostconditionFinding = {
  type: 'broken-link',
  severity: 'warning',
  pageSlug: 'a',
  description: 'a links to missing',
};
const semanticResidual: PostconditionFinding = {
  type: 'contradiction',
  severity: 'critical',
  pageSlug: 'a',
  description: 'a still contradicts b',
};
const originalContradiction: LintFinding = {
  type: 'contradiction',
  severity: 'critical',
  pageSlug: 'a',
  description: 'a contradicts b',
  suggestedFix: null,
};

describe('verifyJobPostconditions', () => {
  beforeEach(() => {
    collectMock.mockReset();
    deterministicMock.mockReset();
    semanticMock.mockReset();
    collectMock.mockReturnValue(appliedScope);
    deterministicMock.mockReturnValue([]);
    semanticMock.mockResolvedValue({
      status: 'clean',
      residualFindings: [],
      error: null,
    });
  });

  it('Fix 合并确定性与语义 residual，并发出统一事件', async () => {
    deterministicMock.mockReturnValue([brokenLink]);
    semanticMock.mockResolvedValue({
      status: 'residual',
      residualFindings: [semanticResidual],
      error: null,
    });
    const emit = vi.fn();

    const report = await verifyJobPostconditions({
      kind: 'fix',
      job,
      subject,
      semanticFindings: [originalContradiction],
      emit,
      now: () => NOW,
    });

    expect(report).toEqual({
      status: 'residual',
      checkedAt: NOW.toISOString(),
      scope: appliedScope,
      residualFindings: [brokenLink, semanticResidual],
      semanticStatus: 'residual',
      verificationError: null,
    });
    expect(emit).toHaveBeenNthCalledWith(
      1,
      'fix:verify:start',
      expect.any(String),
      expect.objectContaining({ jobId: 'job-1', subjectId: 's1' }),
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      'fix:verify:complete',
      expect.any(String),
      {
        postconditionStatus: 'residual',
        residualCount: 2,
        semanticStatus: 'residual',
        postcondition: report,
      },
    );
  });

  it('空 scope 直接 clean，不加载确定性快照或调用语义模型', async () => {
    collectMock.mockReturnValue(emptyScope);
    const emit = vi.fn();

    const report = await verifyJobPostconditions({
      kind: 'fix',
      job,
      subject,
      semanticFindings: [originalContradiction],
      emit,
      now: () => NOW,
    });

    expect(deterministicMock).not.toHaveBeenCalled();
    expect(semanticMock).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: 'clean',
      scope: emptyScope,
      residualFindings: [],
      semanticStatus: 'not-needed',
      verificationError: null,
    });
  });

  it('Curate 只执行确定性校验，不调用语义模型', async () => {
    const emit = vi.fn();
    const curateJob = { ...job, type: 'curate' } as Job;

    const report = await verifyJobPostconditions({
      kind: 'curate',
      job: curateJob,
      subject,
      semanticFindings: [originalContradiction],
      emit,
      now: () => NOW,
    });

    expect(deterministicMock).toHaveBeenCalledWith(subject, appliedScope);
    expect(semanticMock).not.toHaveBeenCalled();
    expect(report.semanticStatus).toBe('not-needed');
  });

  it('collector 异常转为安全 residual，仍发出完成事件', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    collectMock.mockImplementation(() => {
      throw new Error('/private/vault leaked');
    });
    const emit = vi.fn();

    const report = await verifyJobPostconditions({
      kind: 'fix',
      job,
      subject,
      emit,
      now: () => NOW,
    });

    expect(report.status).toBe('residual');
    expect(report.scope).toEqual(emptyScope);
    expect(report.verificationError).toBe('后置校验未能完整执行。');
    expect(JSON.stringify(report)).not.toContain('/private/vault');
    expect(report.residualFindings).toEqual([
      expect.objectContaining({ type: 'verification-error', pageSlug: null }),
    ]);
    expect(emit).toHaveBeenLastCalledWith(
      'fix:verify:complete',
      expect.any(String),
      expect.objectContaining({ postconditionStatus: 'residual', residualCount: 1 }),
    );
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('确定性校验异常保留已收集 scope，不执行语义复检', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    deterministicMock.mockImplementation(() => {
      throw new Error('db unavailable');
    });

    const report = await verifyJobPostconditions({
      kind: 'fix',
      job,
      subject,
      semanticFindings: [originalContradiction],
      emit: vi.fn(),
      now: () => NOW,
    });

    expect(report.scope).toEqual(appliedScope);
    expect(report.status).toBe('residual');
    expect(semanticMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('语义复检失败时保留结构 finding，并明确 semantic failed', async () => {
    deterministicMock.mockReturnValue([brokenLink, brokenLink]);
    semanticMock.mockResolvedValue({
      status: 'failed',
      residualFindings: [semanticResidual],
      error: 'Fix 语义后置复检未完成。',
    });

    const report = await verifyJobPostconditions({
      kind: 'fix',
      job,
      subject,
      semanticFindings: [originalContradiction],
      emit: vi.fn(),
      now: () => NOW,
    });

    expect(report.status).toBe('residual');
    expect(report.semanticStatus).toBe('failed');
    expect(report.verificationError).toBe('Fix 语义后置复检未完成。');
    expect(report.residualFindings).toEqual([brokenLink, semanticResidual]);
  });
});
