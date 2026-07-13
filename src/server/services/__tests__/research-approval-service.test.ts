import { describe, expect, it, beforeEach, vi } from 'vitest';
import type {
  ResearchCandidateIngestRow,
  ResearchCandidateRow,
  ResearchRunFindingRow,
  ResearchRunRow,
} from '@/lib/contracts';
import type { StoredResearchRun } from '@/server/db/repos/research-provenance-repo';

const repoMock = vi.hoisted(() => ({
  findResearchRunById: vi.fn(),
  findResearchRunByJobId: vi.fn(),
  findResearchRunsByJobIds: vi.fn(),
  approveResearchRunAtomic: vi.fn(),
  dismissResearchRunAtomic: vi.fn(),
}));

vi.mock('@/server/db/repos/research-provenance-repo', () => {
  class ResearchProvenanceRepoError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
      this.name = 'ResearchProvenanceRepoError';
    }
  }
  return { ...repoMock, ResearchProvenanceRepoError };
});

import { findingId } from '../finding-identity';
import {
  prepareResearchCandidates,
  researchCandidateId,
  researchCandidateSetHash,
} from '../research-provenance';
import {
  approveResearchRun,
  dismissResearchRun,
  getResearchRun,
  getResearchRunByJobId,
  getResearchRunsByJobIds,
  mapStoredResearchRunToView,
  ResearchApprovalServiceError,
} from '../research-approval-service';
import { ResearchProvenanceRepoError } from '@/server/db/repos/research-provenance-repo';

const NOW = '2026-07-14T00:00:00.000Z';

function fixture(): StoredResearchRun {
  const runId = 'run-1';
  const subjectId = 's1';
  const prepared = prepareResearchCandidates([
    { url: 'https://example.com/b', title: 'B', snippet: 'b', score: 2, reason: 'good' },
    { url: 'https://example.com/a', title: 'A', snippet: 'a', score: 3, reason: 'great' },
  ]);
  const candidates: ResearchCandidateRow[] = prepared.map((candidate) => ({
    id: researchCandidateId(runId, candidate.normalizedUrl),
    runId,
    normalizedUrl: candidate.normalizedUrl,
    snapshotJson: JSON.stringify(candidate.snapshot),
    rank: candidate.rank,
    decision: candidate.rank === 1 ? 'approved' : 'rejected',
    approvalId: 'approval-1',
    decidedAt: NOW,
  }));
  const originalFinding = {
    type: 'coverage-gap' as const,
    severity: 'info' as const,
    pageSlug: 'distributed-systems',
    description: 'Needs authoritative sources',
    suggestedFix: null,
    subjectSlug: 'general',
  };
  const originalFindingId = findingId({ ...originalFinding, subjectId });
  const verificationFinding = {
    ...originalFinding,
    description: 'Still needs one authoritative source',
  };
  const findings: ResearchRunFindingRow[] = [{
    runId,
    findingId: originalFindingId,
    snapshotJson: JSON.stringify(originalFinding),
    verificationStatus: 'residual',
    verifiedAt: NOW,
    verificationSnapshotJson: JSON.stringify(verificationFinding),
  }];
  const run: ResearchRunRow = {
    id: runId,
    subjectId,
    researchJobId: 'research-1',
    origin: 'findings',
    lintJobId: 'lint-1',
    topic: null,
    topicsJson: JSON.stringify(['topic-b', 'topic-a']),
    queriesJson: JSON.stringify(['query-b', 'query-a']),
    candidateSetHash: researchCandidateSetHash(prepared),
    status: 'importing',
    version: 2,
    verificationLintJobId: 'lint-verify-1',
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    errorJson: JSON.stringify({ code: 'RUN_WARNING', message: 'Safe warning' }),
  };
  const deliveries: ResearchCandidateIngestRow[] = [{
    approvalId: 'approval-1',
    candidateId: candidates[1]!.id,
    runId,
    normalizedUrl: candidates[1]!.normalizedUrl,
    status: 'completed',
    sourceId: 'source-1',
    ingestJobId: 'ingest-1',
    operationIdsJson: JSON.stringify(['op-z', 'op-a', 'op-z']),
    touchedPagesJson: JSON.stringify([
      { slug: 'z-page', action: 'updated', system: false },
      { slug: 'a-page', action: 'created', system: false },
      { slug: 'a-page', action: 'updated', system: false },
    ]),
    commitSha: 'abc123',
    claimToken: null,
    leaseExpiresAt: null,
    attemptCount: 2,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    errorJson: null,
  }];
  return {
    run,
    findings,
    candidates,
    approval: {
      id: 'approval-1',
      runId,
      selectedCandidateIdsJson: JSON.stringify([candidates[1]!.id]),
      payloadHash: 'payload-hash',
      idempotencyKey: 'approval-key',
      coordinatorJobId: 'coordinator-1',
      createdAt: NOW,
    },
    deliveries,
  };
}

beforeEach(() => {
  for (const mock of Object.values(repoMock)) mock.mockReset();
});

describe('mapStoredResearchRunToView', () => {
  it('组合候选、delivery、approval 与 finding 验证快照，并稳定排序', () => {
    const view = mapStoredResearchRunToView(fixture());

    expect(view).toMatchObject({
      id: 'run-1',
      subjectId: 's1',
      researchJobId: 'research-1',
      status: 'importing',
      version: 2,
      verificationLintJobId: 'lint-verify-1',
      topics: ['topic-b', 'topic-a'],
      queries: ['query-b', 'query-a'],
      approval: {
        id: 'approval-1',
        coordinatorJobId: 'coordinator-1',
      },
      error: { code: 'RUN_WARNING', message: 'Safe warning' },
    });
    expect(view.candidates.map((candidate) => [candidate.rank, candidate.title]))
      .toEqual([[0, 'B'], [1, 'A']]);
    expect(view.candidates[0]!.delivery).toBeNull();
    expect(view.candidates[1]!.delivery).toMatchObject({
      operationIds: ['op-a', 'op-z'],
      touchedPages: [
        { slug: 'a-page', action: 'created', system: false },
        { slug: 'z-page', action: 'updated', system: false },
      ],
      attemptCount: 2,
    });
    expect(view.findings[0]).toMatchObject({
      verificationStatus: 'residual',
      finding: {
        id: view.findings[0]!.findingId,
        subjectId: 's1',
        subjectSlug: 'general',
        description: 'Needs authoritative sources',
      },
      verificationFinding: {
        subjectId: 's1',
        description: 'Still needs one authoritative source',
      },
    });
  });

  it('非关键日志 JSON 损坏时返回脱敏降级，不泄露原始内容', () => {
    const stored = fixture();
    stored.run.topicsJson = '{';
    stored.run.queriesJson = 'null';
    stored.run.errorJson = '{"message":"/private/secret';
    stored.deliveries[0]!.operationIdsJson = '{';
    stored.deliveries[0]!.touchedPagesJson = '[{"slug":42}]';
    stored.deliveries[0]!.errorJson = '{"message":"token=secret';
    stored.findings[0]!.verificationSnapshotJson = '{';

    const view = mapStoredResearchRunToView(stored);

    expect(view.topics).toEqual([]);
    expect(view.queries).toEqual([]);
    expect(view.error).toEqual({ message: 'Stored error details are unavailable.' });
    expect(view.candidates[1]!.delivery).toMatchObject({
      operationIds: [],
      touchedPages: [],
      error: { message: 'Stored error details are unavailable.' },
    });
    expect(view.findings[0]!.verificationFinding).toBeNull();
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('candidate 或 approval 关键证据损坏时 fail-closed', () => {
    const badCandidate = fixture();
    badCandidate.candidates[0]!.snapshotJson = '{';
    expect(() => mapStoredResearchRunToView(badCandidate))
      .toThrowError(expect.objectContaining({ code: 'RESEARCH_RUN_NOT_APPROVABLE' }));

    const badApproval = fixture();
    badApproval.approval!.selectedCandidateIdsJson = JSON.stringify(['unknown']);
    expect(() => mapStoredResearchRunToView(badApproval))
      .toThrowError(expect.objectContaining({ code: 'RESEARCH_RUN_NOT_APPROVABLE' }));
  });
});

describe('Research approval service', () => {
  it('按 run ID / researchJobId / 批量 job IDs 进行 subject-scoped 读取', () => {
    const stored = fixture();
    repoMock.findResearchRunById.mockReturnValue(stored);
    repoMock.findResearchRunByJobId.mockReturnValue(stored);
    repoMock.findResearchRunsByJobIds.mockReturnValue([stored]);

    expect(getResearchRun('run-1', 's1').id).toBe('run-1');
    expect(getResearchRunByJobId('research-1', 's1')?.id).toBe('run-1');
    expect(getResearchRunsByJobIds(['research-1'], 's1').map((run) => run.id)).toEqual(['run-1']);
    expect(repoMock.findResearchRunById).toHaveBeenCalledWith('run-1', 's1');
    expect(repoMock.findResearchRunByJobId).toHaveBeenCalledWith('research-1', 's1');
    expect(repoMock.findResearchRunsByJobIds).toHaveBeenCalledWith(['research-1'], 's1');
  });

  it('跨 subject 或不存在统一返回 RESEARCH_RUN_NOT_FOUND', () => {
    repoMock.findResearchRunById.mockReturnValue(null);
    expect(() => getResearchRun('run-1', 's2')).toThrowError(expect.objectContaining({
      code: 'RESEARCH_RUN_NOT_FOUND',
      httpStatus: 404,
    }));
  });

  it('批准返回最新 view、coordinatorJobId 与 replay 标记', () => {
    const stored = fixture();
    repoMock.approveResearchRunAtomic.mockReturnValue({
      stored,
      coordinatorJobId: 'coordinator-1',
      replayed: false,
    });
    const result = approveResearchRun({
      runId: 'run-1',
      subjectId: 's1',
      candidateIds: [stored.candidates[1]!.id],
      expectedVersion: 1,
      idempotencyKey: 'key-1',
    });
    expect(result).toMatchObject({
      coordinatorJobId: 'coordinator-1',
      replayed: false,
      run: { id: 'run-1', status: 'importing' },
    });
  });

  it.each([
    ['run-not-found', 'RESEARCH_RUN_NOT_FOUND', 404],
    ['run-stale', 'RESEARCH_RUN_STALE', 409],
    ['already-approved', 'RESEARCH_ALREADY_APPROVED', 409],
    ['idempotency-conflict', 'RESEARCH_IDEMPOTENCY_CONFLICT', 409],
    ['selection-invalid', 'RESEARCH_SELECTION_INVALID', 400],
    ['run-not-approvable', 'RESEARCH_RUN_NOT_APPROVABLE', 409],
  ] as const)('repo %s 映射为 %s', (repoCode, serviceCode, status) => {
    const latest = fixture();
    repoMock.approveResearchRunAtomic.mockImplementation(() => {
      throw new ResearchProvenanceRepoError(repoCode, 'internal URL https://secret.example');
    });
    repoMock.findResearchRunById.mockReturnValue(latest);

    try {
      approveResearchRun({
        runId: 'run-1', subjectId: 's1', candidateIds: ['candidate-1'],
        expectedVersion: 1, idempotencyKey: 'key-1',
      });
      throw new Error('expected approval to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchApprovalServiceError);
      expect(error).toMatchObject({ code: serviceCode, httpStatus: status });
      expect((error as Error).message).not.toContain('secret.example');
      if (repoCode === 'run-stale' || repoCode === 'already-approved') {
        expect((error as ResearchApprovalServiceError).run?.id).toBe('run-1');
      }
    }
  });

  it('dismiss 返回 subject-scoped 最新 view，已批准状态由 repo 映射为不可驳回', () => {
    const stored = fixture();
    stored.run.status = 'dismissed';
    stored.approval = null;
    stored.deliveries = [];
    stored.candidates.forEach((candidate) => {
      candidate.decision = 'rejected';
      candidate.approvalId = null;
    });
    repoMock.dismissResearchRunAtomic.mockReturnValue(stored);
    expect(dismissResearchRun('run-1', 's1')).toMatchObject({ status: 'dismissed' });

    repoMock.dismissResearchRunAtomic.mockImplementation(() => {
      throw new ResearchProvenanceRepoError('run-not-approvable', 'already approved');
    });
    expect(() => dismissResearchRun('run-1', 's1')).toThrowError(expect.objectContaining({
      code: 'RESEARCH_RUN_NOT_APPROVABLE',
      httpStatus: 409,
    }));
  });
});
