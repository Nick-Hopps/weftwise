import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, LintFinding, RemediationContext, Subject } from '@/lib/contracts';
import { findingId } from '../finding-identity';

const queueMock = vi.hoisted(() => ({
  getOrCreateJobAtomic: vi.fn(),
  listLatestCompletedLint: vi.fn(),
  list: vi.fn(),
}));
const webSearchMock = vi.hoisted(() => ({
  isWebSearchConfigured: vi.fn(),
}));
const sourceReingestMock = vi.hoisted(() => ({
  reingestOrphanSource: vi.fn(),
}));
const MockSourceReingestError = vi.hoisted(() => class SourceReingestError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: 'source-not-found' | 'already-referenced' | 'in-flight' | 'requeue-conflict',
    message: string,
  ) {
    super(message);
    this.name = 'SourceReingestError';
  }
});

vi.mock('@/server/jobs/queue', () => queueMock);
vi.mock('@/server/search/web-search', () => webSearchMock);
vi.mock('../source-reingest', () => ({
  SourceReingestError: MockSourceReingestError,
  reingestOrphanSource: sourceReingestMock.reingestOrphanSource,
}));

import { MAX_RESEARCH_BATCH_JOBS } from '@/lib/research-plan';
import {
  MAX_REMEDIATION_FINDINGS,
  RemediationRequestError,
  remediate,
} from '../remediation-service';
import { SourceReingestError } from '../source-reingest';

const SUBJECT: Subject = {
  id: 's1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-07-13T09:00:00.000Z',
  updatedAt: '2026-07-13T09:00:00.000Z',
};

function rawFinding(
  type: LintFinding['type'],
  pageSlug: string,
  overrides: Partial<LintFinding> = {},
) {
  return {
    type,
    severity: 'warning' as const,
    pageSlug,
    description: `${type}:${pageSlug}`,
    suggestedFix: null,
    subjectId: SUBJECT.id,
    subjectSlug: SUBJECT.slug,
    ...overrides,
  };
}

const BROKEN = rawFinding('broken-link', 'broken');
const CONTRADICTION = rawFinding('contradiction', 'contradiction');
const ORPHAN = rawFinding('orphan', 'orphan');
const SECOND_ORPHAN = rawFinding('orphan', 'orphan-two');
const GAP = rawFinding('coverage-gap', 'gap');
const THIN_PAGE = rawFinding('thin-page', 'thin-without-sources');
const ORPHAN_SOURCE = rawFinding('orphan-source', '', { sourceId: 'source-1', sourceFilename: 'one.md' });
const SECOND_ORPHAN_SOURCE = rawFinding('orphan-source', '', {
  sourceId: 'source-2',
  sourceFilename: 'two.md',
});
const ORPHAN_SOURCE_WITHOUT_ID = rawFinding('orphan-source', '', { sourceFilename: 'missing.md' });
/** 批量上限用例需要多于上限的可研究 finding。 */
const MANY_GAPS = Array.from(
  { length: MAX_RESEARCH_BATCH_JOBS + 1 },
  (_, index) => rawFinding('coverage-gap', `bulk-gap-${index}`),
);

const BROKEN_ID = findingId(BROKEN);
const CONTRADICTION_ID = findingId(CONTRADICTION);
const ORPHAN_ID = findingId(ORPHAN);
const SECOND_ORPHAN_ID = findingId(SECOND_ORPHAN);
const GAP_ID = findingId(GAP);
const THIN_PAGE_ID = findingId(THIN_PAGE);
const ORPHAN_SOURCE_ID = findingId(ORPHAN_SOURCE);
const SECOND_ORPHAN_SOURCE_ID = findingId(SECOND_ORPHAN_SOURCE);
const ORPHAN_SOURCE_WITHOUT_ID_ID = findingId(ORPHAN_SOURCE_WITHOUT_ID);
let remediationJobs: Job[] = [];
/** 让每次真实创建返回不同 job id，便于断言拆分出的 jobIds 集合。 */
let createdJobCount = 0;

const ALL_FINDINGS = [
  BROKEN,
  CONTRADICTION,
  ORPHAN,
  SECOND_ORPHAN,
  GAP,
  THIN_PAGE,
  ORPHAN_SOURCE,
  SECOND_ORPHAN_SOURCE,
  ORPHAN_SOURCE_WITHOUT_ID,
  ...MANY_GAPS,
];

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'lint-1',
    type: 'lint',
    status: 'completed',
    subjectId: SUBJECT.id,
    paramsJson: JSON.stringify({ subjectId: SUBJECT.id }),
    resultJson: JSON.stringify({ findings: ALL_FINDINGS }),
    createdAt: '2026-07-13T10:00:00.000Z',
    startedAt: '2026-07-13T10:00:01.000Z',
    completedAt: '2026-07-13T10:01:00.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

function context(action: RemediationContext['action'], findingIds: string[]): RemediationContext {
  return { lintJobId: 'lint-1', findingIds: [...new Set(findingIds)].sort(), action };
}

beforeEach(() => {
  vi.clearAllMocks();
  remediationJobs = [];
  queueMock.listLatestCompletedLint.mockReturnValue(makeJob());
  queueMock.list.mockReturnValue([makeJob()]);
  createdJobCount = 0;
  queueMock.getOrCreateJobAtomic.mockImplementation((input: {
    matcher: (jobs: Job[]) => Job | null;
    beforeCreate?: () => void;
  }) => {
    const duplicate = input.matcher(remediationJobs);
    if (duplicate) return { job: duplicate, deduplicated: true };
    input.beforeCreate?.();
    createdJobCount += 1;
    return { job: { id: `job-${createdJobCount}` }, deduplicated: false };
  });
  webSearchMock.isWebSearchConfigured.mockReturnValue(true);
  sourceReingestMock.reingestOrphanSource.mockReturnValue({
    jobId: 'ingest-1',
    deduplicated: false,
  });
});

describe('remediate 参数与快照校验', () => {
  it('stale lintJobId 返回 409 且不入队', async () => {
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'old',
      findingIds: [BROKEN_ID],
      action: 'fix',
    })).rejects.toMatchObject({ status: 409, code: 'stale-snapshot' });
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
    expect(sourceReingestMock.reingestOrphanSource).not.toHaveBeenCalled();
  });

  it.each([
    ['空 lintJobId', { lintJobId: '   ', findingIds: [BROKEN_ID], action: 'fix' }],
    ['非法 action', { lintJobId: 'lint-1', findingIds: [BROKEN_ID], action: 'review-source' }],
    ['findingIds 不是数组', { lintJobId: 'lint-1', findingIds: BROKEN_ID, action: 'fix' }],
    ['findingIds 含非字符串', { lintJobId: 'lint-1', findingIds: [BROKEN_ID, 1], action: 'fix' }],
    ['findingIds 含大写 hex', { lintJobId: 'lint-1', findingIds: ['A'.repeat(64)], action: 'fix' }],
  ] as const)('%s → 400 且没有副作用', async (_label, input) => {
    await expect(remediate({ subject: SUBJECT, ...input } as never)).rejects.toMatchObject({
      status: 400,
    });
    expect(queueMock.list).not.toHaveBeenCalled();
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
    expect(sourceReingestMock.reingestOrphanSource).not.toHaveBeenCalled();
  });

  it('按原始数组限制 1-100 项，不允许重复 ID 在去重后绕过上限', async () => {
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: Array.from({ length: MAX_REMEDIATION_FINDINGS + 1 }, () => BROKEN_ID),
      action: 'fix',
    })).rejects.toMatchObject({ status: 400, code: 'invalid-finding-count' });
    expect(queueMock.list).not.toHaveBeenCalled();
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
  });

  it('任意 finding ID 缺失则整体 stale，不部分入队', async () => {
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [BROKEN_ID, 'f'.repeat(64)],
      action: 'fix',
    })).rejects.toMatchObject({ status: 409, code: 'stale-snapshot' });
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
  });

  it('action 与单条 finding 不匹配 → 400', async () => {
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [ORPHAN_ID],
      action: 'fix',
    })).rejects.toMatchObject({ status: 400, code: 'action-not-allowed' });
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
  });

  it('action 混合批次只要有一条不允许就整体拒绝', async () => {
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [BROKEN_ID, ORPHAN_ID],
      action: 'fix',
    })).rejects.toMatchObject({ status: 400, code: 'action-not-allowed' });
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
  });
});

describe('remediate 工作流编排', () => {
  it('Fix 批量一次入队，并对重复 IDs 去重排序后携带 remediationContext', async () => {
    const result = await remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [CONTRADICTION_ID, BROKEN_ID, BROKEN_ID],
      action: 'fix',
    });

    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledTimes(1);
    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledWith({
      type: 'fix',
      params: {
        subjectId: SUBJECT.id,
        remediationContext: context('fix', [CONTRADICTION_ID, BROKEN_ID]),
      },
      subjectId: SUBJECT.id,
      lintRanAt: '2026-07-13T10:01:00.000Z',
      matcher: expect.any(Function),
    });
    expect(queueMock.listLatestCompletedLint).toHaveBeenCalledWith(SUBJECT.id);
    expect(queueMock.list).not.toHaveBeenCalled();
    expect(result).toEqual({ jobIds: ['job-1'], deduplicated: false });
  });

  it('Curate 只把选中 findings 的 pageSlug 去重后作为 seeds', async () => {
    await remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [SECOND_ORPHAN_ID, ORPHAN_ID],
      action: 'curate',
    });

    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledWith({
      type: 'curate',
      params: {
        scope: 'pages',
        slugs: ['orphan', 'orphan-two'],
        subjectId: SUBJECT.id,
        remediationContext: context('curate', [SECOND_ORPHAN_ID, ORPHAN_ID]),
      },
      subjectId: SUBJECT.id,
      lintRanAt: '2026-07-13T10:01:00.000Z',
      matcher: expect.any(Function),
    });
  });

  it('Research 参数满足 worker 契约并携带规范化上下文', async () => {
    const result = await remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [GAP_ID, GAP_ID],
      action: 'research',
    });

    expect(result).toEqual({ jobIds: ['job-1'], deduplicated: false });
    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledWith({
      type: 'research',
      params: {
        findingIds: [GAP_ID],
        lintJobId: 'lint-1',
        subjectId: SUBJECT.id,
        remediationContext: context('research', [GAP_ID]),
      },
      subjectId: SUBJECT.id,
      lintRanAt: '2026-07-13T10:01:00.000Z',
      matcher: expect.any(Function),
      beforeCreate: expect.any(Function),
    });
  });

  it('router 允许的 thin-page 与 coverage-gap 各自生成一个单主题 Research job', async () => {
    const result = await remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [THIN_PAGE_ID, GAP_ID],
      action: 'research',
    });

    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledTimes(2);
    for (const id of [THIN_PAGE_ID, GAP_ID]) {
      expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledWith({
        type: 'research',
        params: {
          findingIds: [id],
          lintJobId: 'lint-1',
          subjectId: SUBJECT.id,
          remediationContext: context('research', [id]),
        },
        subjectId: SUBJECT.id,
        lintRanAt: '2026-07-13T10:01:00.000Z',
        matcher: expect.any(Function),
        beforeCreate: expect.any(Function),
      });
    }
    expect(result).toEqual({ jobIds: ['job-1', 'job-2'], deduplicated: false });
  });

  it('Research 未配置 Web Search → 422，且零 job 被创建', async () => {
    webSearchMock.isWebSearchConfigured.mockReturnValue(false);
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [GAP_ID, THIN_PAGE_ID],
      action: 'research',
    })).rejects.toMatchObject({ status: 422, code: 'web-search-not-configured' });
    // 首个创建尝试即抛，后续主题不再尝试，也没有任何 job 落库。
    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledTimes(1);
    expect(createdJobCount).toBe(0);
  });

  it('Re-ingest 严格限制单条且必须包含 sourceId', async () => {
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [ORPHAN_SOURCE_ID, SECOND_ORPHAN_SOURCE_ID],
      action: 're-ingest',
    })).rejects.toMatchObject({ status: 400, code: 'invalid-reingest-scope' });
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [ORPHAN_SOURCE_WITHOUT_ID_ID],
      action: 're-ingest',
    })).rejects.toMatchObject({ status: 400, code: 'invalid-reingest-scope' });
    expect(sourceReingestMock.reingestOrphanSource).not.toHaveBeenCalled();
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
  });

  it('Re-ingest 委托共用 helper 并传递 remediationContext', async () => {
    const result = await remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [ORPHAN_SOURCE_ID],
      action: 're-ingest',
    });

    expect(sourceReingestMock.reingestOrphanSource).toHaveBeenCalledWith({
      subjectId: SUBJECT.id,
      sourceId: 'source-1',
      remediationContext: context('re-ingest', [ORPHAN_SOURCE_ID]),
    });
    expect(result).toEqual({ jobIds: ['ingest-1'], deduplicated: false });
  });

  it('Re-ingest 原子 helper 复用同 context in-flight 时透传 deduplicated', async () => {
    sourceReingestMock.reingestOrphanSource.mockReturnValue({
      jobId: 'ingest-existing',
      deduplicated: true,
    });

    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [ORPHAN_SOURCE_ID],
      action: 're-ingest',
    })).resolves.toEqual({ jobIds: ['ingest-existing'], deduplicated: true });
  });

  it('统一入口把 source 404 映射为 409，其余 typed 状态保持', async () => {
    sourceReingestMock.reingestOrphanSource.mockImplementationOnce(() => {
      throw new SourceReingestError(404, 'source-not-found', 'Source not found');
    });
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [ORPHAN_SOURCE_ID],
      action: 're-ingest',
    })).rejects.toMatchObject({ status: 409, code: 'source-not-found' });

    sourceReingestMock.reingestOrphanSource.mockImplementationOnce(() => {
      throw new SourceReingestError(409, 'requeue-conflict', 'conflict');
    });
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [ORPHAN_SOURCE_ID],
      action: 're-ingest',
    })).rejects.toMatchObject({ status: 409, code: 'requeue-conflict' });
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
  });
});

describe('Research 按主题拆分为独立 job', () => {
  const gapIds = MANY_GAPS.map((finding) => findingId(finding));
  // 服务端按 ID 排序遍历，断言必须用同一顺序，不能假设调用方的传入顺序。
  const [FIRST_GAP_ID, SECOND_GAP_ID] = [gapIds[0], gapIds[1]].sort();

  it('每个主题一个 job，findingIds 长度恒为 1 且并集等于请求集合', async () => {
    const requested = gapIds.slice(0, MAX_RESEARCH_BATCH_JOBS);
    const result = await remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: requested,
      action: 'research',
    });

    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledTimes(requested.length);
    expect(result.jobIds).toHaveLength(requested.length);
    expect(new Set(result.jobIds).size).toBe(requested.length);

    const perJobFindingIds = queueMock.getOrCreateJobAtomic.mock.calls.map(
      (call) => (call[0] as { params: { findingIds: string[] } }).params.findingIds,
    );
    expect(perJobFindingIds.every((ids: string[]) => ids.length === 1)).toBe(true);
    expect(new Set(perJobFindingIds.flat())).toEqual(new Set(requested));
  });

  it('每个 job 的 remediationContext 也只覆盖自己那一条 finding', async () => {
    await remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [gapIds[0], gapIds[1]],
      action: 'research',
    });

    const contexts = queueMock.getOrCreateJobAtomic.mock.calls.map(
      (call) => (call[0] as { params: { remediationContext: RemediationContext } })
        .params.remediationContext,
    );
    expect(contexts).toEqual([
      context('research', [FIRST_GAP_ID]),
      context('research', [SECOND_GAP_ID]),
    ]);
  });

  it(`超过 ${MAX_RESEARCH_BATCH_JOBS} 个主题 → 400 且零 job 被创建`, async () => {
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: gapIds,
      action: 'research',
    })).rejects.toMatchObject({ status: 400, code: 'invalid-research-batch' });
    expect(queueMock.getOrCreateJobAtomic).not.toHaveBeenCalled();
  });

  it('上限只约束 research，其他动作仍可提交更多 finding', async () => {
    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: gapIds.map(() => ORPHAN_ID),
      action: 'curate',
    })).resolves.toEqual({ jobIds: ['job-1'], deduplicated: false });
  });

  it('整批命中 duplicate 时 deduplicated 为 true 且不校验 Web Search 配置', async () => {
    remediationJobs = [FIRST_GAP_ID, SECOND_GAP_ID].map((id, index) => makeJob({
      id: `research-duplicate-${index}`,
      type: 'research',
      status: 'pending',
      paramsJson: JSON.stringify({ remediationContext: context('research', [id]) }),
    }));
    webSearchMock.isWebSearchConfigured.mockReturnValue(false);

    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [gapIds[0], gapIds[1]],
      action: 'research',
    })).resolves.toEqual({
      jobIds: ['research-duplicate-0', 'research-duplicate-1'],
      deduplicated: true,
    });
    expect(webSearchMock.isWebSearchConfigured).not.toHaveBeenCalled();
  });

  it('只有部分主题命中 duplicate 时 deduplicated 为 false', async () => {
    remediationJobs = [makeJob({
      id: 'research-duplicate-0',
      type: 'research',
      status: 'pending',
      paramsJson: JSON.stringify({ remediationContext: context('research', [FIRST_GAP_ID]) }),
    })];

    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [gapIds[0], gapIds[1]],
      action: 'research',
    })).resolves.toEqual({
      jobIds: ['research-duplicate-0', 'job-1'],
      deduplicated: false,
    });
  });
});

describe('remediate 幂等复用', () => {
  it.each([
    ['pending', 'pending', null],
    ['running', 'running', null],
    ['completed 且尚未被新 lint 复检', 'completed', '2026-07-13T10:01:01.000Z'],
  ] as const)('复用 %s 的同 context job', async (_label, status, completedAt) => {
    const duplicate = makeJob({
      id: `duplicate-${status}`,
      type: 'fix',
      status,
      paramsJson: JSON.stringify({ remediationContext: context('fix', [BROKEN_ID]) }),
      completedAt,
      createdAt: '2026-07-13T10:02:00.000Z',
    });
    remediationJobs = [duplicate];

    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [BROKEN_ID],
      action: 'fix',
    })).resolves.toEqual({ jobIds: [duplicate.id], deduplicated: true });
    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledTimes(1);
  });

  it('已被新 lint 复检的 completed job 不复用', async () => {
    const oldCompleted = makeJob({
      id: 'old-completed',
      type: 'fix',
      status: 'completed',
      paramsJson: JSON.stringify({ remediationContext: context('fix', [BROKEN_ID]) }),
      completedAt: '2026-07-13T10:00:59.000Z',
    });
    remediationJobs = [oldCompleted];

    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [BROKEN_ID],
      action: 'fix',
    })).resolves.toEqual({ jobIds: ['job-1'], deduplicated: false });
    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledTimes(1);
  });

  it('Research duplicate 在当前 Web Search 配置变化时仍优先复用', async () => {
    const duplicate = makeJob({
      id: 'research-duplicate',
      type: 'research',
      status: 'pending',
      paramsJson: JSON.stringify({ remediationContext: context('research', [GAP_ID]) }),
    });
    remediationJobs = [duplicate];
    webSearchMock.isWebSearchConfigured.mockReturnValue(false);

    await expect(remediate({
      subject: SUBJECT,
      lintJobId: 'lint-1',
      findingIds: [GAP_ID],
      action: 'research',
    })).resolves.toEqual({ jobIds: [duplicate.id], deduplicated: true });
    expect(webSearchMock.isWebSearchConfigured).not.toHaveBeenCalled();
    expect(queueMock.getOrCreateJobAtomic).toHaveBeenCalledTimes(1);
  });
});

describe('RemediationRequestError', () => {
  it('保留稳定 status/code 并继承 Error', () => {
    const error = new RemediationRequestError(409, 'stale-snapshot', 'changed');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status: 409, code: 'stale-snapshot', message: 'changed' });
  });
});
