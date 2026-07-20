import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  EnrichedLintFinding,
  HealthSnapshot,
  Job,
  RemediationActionType,
  RemediationPlan,
  ResearchRunView,
} from '@/lib/contracts';
import {
  activeJobsHydrationBusyActions,
  actionFindingIds,
  actionForFinding,
  blockingRecoverableActions,
  createActionGate,
  createLintRerunQueue,
  fetchActiveHealthJobs,
  healthActionButtonState,
  isHealthOriginCurrent,
  nextDeleteArmed,
  readDeleteSourceResult,
  readResearchRun,
  readResearchRunId,
  recentOutcomeBannerTone,
  recentOutcomeCounts,
  persistedBusyActions,
  healthTerminalInvalidationKeys,
  selectRecoverableHealthJobs,
  researchBacklogPatchBody,
  researchApprovalBody,
  requestHealthJobCancel,
  summarizeFixOutcomes,
} from '../remediation-ui';
import { FindingRow, remediationStatusLabel } from '../finding-row';
import { createI18n } from '@/lib/i18n/translator';

const { t } = createI18n('en');

vi.mock('@/components/ui/tag', async () => {
  const ReactModule = await import('react');
  return {
    Tag: ({ children }: React.PropsWithChildren) => ReactModule.createElement('span', null, children),
  };
});

vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, disabled }: React.PropsWithChildren<{ disabled?: boolean }>) =>
      ReactModule.createElement('button', { disabled }, children),
    buttonVariants: () => '',
  };
});

function finding(id: string, type: EnrichedLintFinding['type']): EnrichedLintFinding {
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

function plan(
  findingId: string,
  actions: RemediationPlan['actions'],
): RemediationPlan {
  return {
    findingId,
    workflow: actions[0]?.type === 'research' ? 'research' : 'fix',
    status: 'queued',
    actions,
    reason: '由服务端计划决定',
  };
}

function job(
  id: string,
  type: Job['type'],
  params: unknown,
  createdAt: string,
): Job {
  return {
    id,
    type,
    status: 'running',
    paramsJson: JSON.stringify(params),
    resultJson: null,
    createdAt,
    startedAt: createdAt,
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 1,
    subjectId: 'subject-1',
  };
}

const broken = finding('broken', 'broken-link');
const gap = finding('gap', 'coverage-gap');
const readonly = finding('readonly', 'orphan');

const snapshot: HealthSnapshot = {
  jobId: 'lint-1',
  ranAt: '2026-07-13T00:00:00.000Z',
  bySeverity: { critical: 0, warning: 3, info: 0 },
  // 故意让映射对象与 findings 顺序不同，验证批量顺序只服从快照 findings。
  findings: [gap, broken, readonly],
  remediations: {
    [broken.id]: plan(broken.id, [
      { type: 'fix', label: 'Fix', destructive: false },
    ]),
    [gap.id]: plan(gap.id, [
      { type: 'research', label: 'Research', destructive: false },
    ]),
    [readonly.id]: plan(readonly.id, []),
  },
  recentOutcomes: {},
};

describe('Health remediation UI helper', () => {
  it('三个处置按钮共用 idle、starting、running 与 cancelling 状态', () => {
    expect(healthActionButtonState(false, null, false)).toBe('idle');
    expect(healthActionButtonState(true, null, false)).toBe('starting');
    expect(healthActionButtonState(true, 'job-1', false)).toBe('running');
    expect(healthActionButtonState(true, 'job-1', true)).toBe('cancelling');
    expect(healthActionButtonState(false, 'stale-job', false)).toBe('idle');
  });

  it('取消处置 job 区分成功、已终态幂等收敛与可见失败', async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    await expect(requestHealthJobCancel('fix/job', async (url, init) => {
      requests.push({ url, method: init?.method });
      return Response.json({ status: 'failed' });
    }, t)).resolves.toBe('cancelled');
    expect(requests).toEqual([{ url: '/api/jobs/fix%2Fjob/cancel', method: 'POST' }]);

    await expect(requestHealthJobCancel('done', async () => Response.json(
      { error: 'Cannot cancel a job with status "completed"' },
      { status: 409 },
    ), t)).resolves.toBe('already-terminal');

    await expect(requestHealthJobCancel('missing', async () => Response.json(
      { error: 'Job not found' },
      { status: 404 },
    ), t)).rejects.toThrow('Job not found');

    await expect(requestHealthJobCancel('broken', async () => new Response('', {
      status: 503,
    }), t)).rejects.toThrow('Stop request failed (503).');
  });

  it('批量 ID 只来自服务端允许的 action，并保持 findings 顺序', () => {
    expect(actionFindingIds(snapshot, 'research')).toEqual([gap.id]);
    expect(actionFindingIds(snapshot, 'fix')).toEqual([broken.id]);
  });

  it('找不到 plan 或 action 时不返回客户端猜测', () => {
    expect(actionForFinding(snapshot, 'unknown', 'fix')).toBeNull();
    expect(actionForFinding(snapshot, gap.id, 'fix')).toBeNull();
  });

  it('运行时未知 action 不匹配任何计划动作', () => {
    const unknownAction = 'rebuild' as RemediationActionType;
    expect(actionForFinding(snapshot, broken.id, unknownAction)).toBeNull();
    expect(actionFindingIds(snapshot, unknownAction)).toEqual([]);
  });

  it('只读 plan 不产生任何可执行 finding ID', () => {
    expect(actionForFinding(snapshot, readonly.id, 'fix')).toBeNull();
    expect(actionForFinding(snapshot, readonly.id, 'curate')).toBeNull();
    expect(actionForFinding(snapshot, readonly.id, 'research')).toBeNull();
    expect(actionForFinding(snapshot, readonly.id, 're-ingest')).toBeNull();
  });

  it('近期结果超过 50 条时仍完整统计所有终态', () => {
    const recentOutcomes = Object.fromEntries([
      ...Array.from({ length: 55 }, (_, index) => [`fixed-${index}`, 'fixed'] as const),
      ...Array.from({ length: 7 }, (_, index) => [`failed-${index}`, 'failed'] as const),
      ...Array.from({ length: 3 }, (_, index) => [`skipped-${index}`, 'skipped'] as const),
      ['queued', 'queued'] as const,
      ['awaiting', 'awaiting-approval'] as const,
    ]);

    expect(recentOutcomeCounts({ ...snapshot, recentOutcomes })).toEqual({
      fixed: 55,
      failed: 7,
      skipped: 3,
    });
  });

  it('Fix 完成摘要按逐 finding 结果统计，不把 writes 当 fixed', () => {
    expect(summarizeFixOutcomes({
      writes: 5,
      residualCount: 7,
      perFindingOutcomes: {
        a: 'fixed', b: 'fixed', c: 'fixed',
        d: 'failed', e: 'failed', f: 'failed', g: 'failed',
        h: 'failed', i: 'failed', j: 'failed', k: 'failed',
        l: 'skipped',
      },
    })).toEqual({ fixed: 3, failed: 8, skipped: 1 });
  });

  it('Fix 完成摘要对缺失或非法逐 finding 结果保守降级', () => {
    expect(summarizeFixOutcomes({ writes: 2 })).toEqual({
      fixed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(summarizeFixOutcomes(null)).toEqual({
      fixed: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it('动作门同步阻止同 action 重入，同时允许不同 action 并发', () => {
    const gate = createActionGate();
    const origin = { generation: 1, subjectId: 'subject-1', scope: 'subject' as const };

    expect(gate.tryAcquire('research', origin)).toBe(true);
    expect(gate.tryAcquire('research', origin)).toBe(false);
    expect(gate.tryAcquire('fix', origin)).toBe(true);
    expect(gate.isBusy('research')).toBe(true);
    expect(gate.release('research', { ...origin, generation: 0 })).toBe(false);
    expect(gate.release('research', origin)).toBe(true);
    expect(gate.isBusy('research')).toBe(false);
  });

  it('origin 必须同时匹配 generation、subject 与 scope', () => {
    const current = { generation: 2, subjectId: 'subject-1', scope: 'subject' as const };
    expect(isHealthOriginCurrent(current, current)).toBe(true);
    expect(isHealthOriginCurrent(current, { ...current, generation: 1 })).toBe(false);
    expect(isHealthOriginCurrent(current, { ...current, subjectId: 'subject-2' })).toBe(false);
    expect(isHealthOriginCurrent(current, { ...current, scope: 'all' })).toBe(false);
  });

  it('近期结果 banner 按 failed、skipped、fixed 优先级选择 tone', () => {
    expect(recentOutcomeBannerTone({ fixed: 8, failed: 1, skipped: 0 })).toBe('danger');
    expect(recentOutcomeBannerTone({ fixed: 8, failed: 0, skipped: 1 })).toBe('warning');
    expect(recentOutcomeBannerTone({ fixed: 8, failed: 0, skipped: 0 })).toBe('success');
  });

  it('计划缺失时 FindingRow 只读降级且不隐藏 finding', () => {
    const html = renderToStaticMarkup(React.createElement(FindingRow, {
      finding: broken,
      plan: undefined as never,
      onAction: () => undefined,
    }));

    expect(html).toContain('Plan unavailable');
    expect(html).toContain('Re-run the health check');
    expect(html).not.toContain('Fix issues');
  });

  it('FindingRow 展示用户态处置状态而非内部枚举', () => {
    const html = renderToStaticMarkup(React.createElement(FindingRow, {
      finding: broken,
      plan: {
        ...plan(broken.id, [{ type: 'fix', label: 'Fix issue', destructive: false }]),
        status: 'awaiting-approval',
      },
    }));

    expect(remediationStatusLabel('awaiting-approval')).toBe('health.remediation.awaitingApproval');
    expect(html).toContain('Needs action');
    expect(html).not.toContain('awaiting-approval');
  });

  it('acting 变化或动作点击会解除删除确认状态', () => {
    expect(nextDeleteArmed(false, 'arm')).toBe(true);
    expect(nextDeleteArmed(true, 'acting')).toBe(false);
    expect(nextDeleteArmed(true, 'action')).toBe(false);
  });

  it('Delete source 区分成功、已删除与可见失败', async () => {
    await expect(readDeleteSourceResult(Response.json({ deleted: true }), t))
      .resolves.toBe('deleted');
    await expect(readDeleteSourceResult(Response.json(
      { error: 'Source not found' },
      { status: 404 },
    ), t)).resolves.toBe('already-deleted');
    await expect(readDeleteSourceResult(Response.json(
      { error: 'in-flight' },
      { status: 409 },
    ), t)).rejects.toThrow('Source cannot be deleted while its ingest job is active.');
    await expect(readDeleteSourceResult(Response.json(
      { error: 'Failed to delete source: git broke' },
      { status: 500 },
    ), t)).rejects.toThrow('Failed to delete source: git broke');
  });

  it('Research job 结果只读取 runId，并区分 HTTP、响应 JSON 与 resultJson 错误', async () => {
    await expect(readResearchRunId(new Response('', { status: 503 }), t))
      .rejects.toThrow('Research result request failed (503).');
    await expect(readResearchRunId(new Response('{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }), t)).rejects.toThrow('Research result response is invalid.');
    await expect(readResearchRunId(Response.json({ resultJson: '{' }), t))
      .rejects.toThrow('Research result is invalid.');
    await expect(readResearchRunId(Response.json({
      resultJson: JSON.stringify({ runId: 'run-1', candidates: [] }),
    }), t)).resolves.toBe('run-1');
  });

  it('Research run 响应严格校验，批准 body 不包含 URL', async () => {
    const run = {
      id: 'run-1', subjectId: 'subject-1', researchJobId: 'research-1', origin: 'topic',
      lintJobId: null, topic: 'topic', topics: ['topic'], queries: ['query'],
      candidateSetHash: 'hash', status: 'awaiting-approval', version: 2,
      verificationLintJobId: null, findings: [], candidates: [{
        id: 'candidate-1', url: 'https://example.com', normalizedUrl: 'https://example.com/',
        title: 'Example', snippet: 'Snippet', score: 3, reason: null, rank: 0,
        decision: 'pending', delivery: null,
      }], approval: null, createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z', completedAt: null, error: null,
    } satisfies ResearchRunView;

    await expect(readResearchRun(Response.json({ run }), t)).resolves.toEqual(run);
    await expect(readResearchRun(Response.json({ run: { ...run, candidates: [{ url: 'x' }] } }), t))
      .rejects.toThrow('Research run is invalid.');
    expect(researchApprovalBody(run, ['candidate-1'], 'key-1')).toEqual({
      candidateIds: ['candidate-1'],
      expectedVersion: 2,
      idempotencyKey: 'key-1',
      subjectId: 'subject-1',
    });
    expect(JSON.stringify(researchApprovalBody(run, ['candidate-1'], 'key-1')))
      .not.toContain('https://');
  });

  it('Research backlog PATCH body 固定携带 render 时的 subjectId', () => {
    expect(researchBacklogPatchBody('researched', 'subject-origin', 'research-1')).toEqual({
      status: 'researched',
      researchJobId: 'research-1',
      subjectId: 'subject-origin',
    });
    expect(researchBacklogPatchBody('dismissed', 'subject-origin')).toEqual({
      status: 'dismissed',
      subjectId: 'subject-origin',
    });
  });

  it('刷新恢复 busy 只消费 queued plan 的服务端可执行 action', () => {
    const queuedFix = plan(broken.id, [{ type: 'fix', label: 'Fix', destructive: false }]);
    const finishedResearch = {
      ...plan(gap.id, [{ type: 'research', label: 'Research', destructive: false }]),
      status: 'fixed' as const,
    };
    const queuedReadonly = { ...plan(readonly.id, []), status: 'queued' as const };
    const actions = persistedBusyActions({
      ...snapshot,
      remediations: {
        [broken.id]: queuedFix,
        [gap.id]: finishedResearch,
        [readonly.id]: queuedReadonly,
      },
    });

    expect([...actions]).toEqual(['fix']);
  });

  it('active jobs hydration 未成功前锁住四类 action，成功后释放', () => {
    expect([...activeJobsHydrationBusyActions('subject', 'subject-1', false)]).toEqual([
      'fix',
      'curate',
      'research',
      're-ingest',
    ]);
    expect([...activeJobsHydrationBusyActions('subject', 'subject-1', true)]).toEqual([]);
    expect([...activeJobsHydrationBusyActions('all', 'subject-1', false)]).toEqual([]);
  });

  it('active jobs 严格按 pending 后 running 顺序读取', async () => {
    const events: string[] = [];
    const jobs = await fetchActiveHealthJobs('subject / 1', async (url) => {
      events.push(`fetch:${url}`);
      const status = url.includes('status=pending') ? 'pending' : 'running';
      return {
        ok: true,
        async json() {
          events.push(`json:${status}`);
          return [job(`${status}-job`, 'fix', {}, '2026-07-13T01:00:00Z')];
        },
      };
    });

    expect(events).toEqual([
      'fetch:/api/jobs?status=pending&subjectId=subject%20%2F%201',
      'json:pending',
      'fetch:/api/jobs?status=running&subjectId=subject%20%2F%201',
      'json:running',
    ]);
    expect(jobs.map((item) => item.id)).toEqual(['pending-job', 'running-job']);
  });

  it('Delete 在途时禁用同一行的 Re-ingest action', () => {
    const orphanSource = {
      ...finding('source', 'orphan-source'),
      sourceId: 'source-1',
      sourceFilename: 'source.md',
    };
    const html = renderToStaticMarkup(React.createElement(FindingRow, {
      finding: orphanSource,
      plan: {
        findingId: orphanSource.id,
        workflow: 're-ingest',
        status: 'queued',
        actions: [{ type: 're-ingest', label: 'Retry ingest', destructive: false }],
        reason: '重新摄入来源',
      },
      deleting: true,
      onAction: () => undefined,
      onDeleteSource: () => undefined,
    }));

    expect(html).toContain('<button disabled="">Retry ingest</button>');
  });

  it('lint busy 时同 origin 只排队一次，并在终态 drain', () => {
    const queue = createLintRerunQueue();
    const origin = { generation: 1, subjectId: 'subject-1', scope: 'subject' as const };

    expect(queue.request(origin)).toBe('start');
    expect(queue.request(origin)).toBe('queued');
    expect(queue.request(origin)).toBe('queued');
    expect(queue.finish(origin, origin)).toEqual({ origin });
    expect(queue.request(origin)).toBe('start');
  });

  it('lint pending rerun 在 current origin 改变后丢弃', () => {
    const queue = createLintRerunQueue();
    const origin = { generation: 1, subjectId: 'subject-1', scope: 'subject' as const };
    const nextOrigin = { generation: 2, subjectId: 'subject-2', scope: 'subject' as const };

    expect(queue.request(origin)).toBe('start');
    expect(queue.request(origin)).toBe('queued');
    expect(queue.request(nextOrigin)).toBe('ignored');
    expect(queue.finish(origin, nextOrigin)).toBeNull();
  });

  it('恢复 Health remediation 时只恢复原 workflow，不排队修后 lint', () => {
    const selected = selectRecoverableHealthJobs(snapshot, [
      job('fix-1', 'fix', {
        remediationContext: {
          lintJobId: 'lint-origin',
          findingIds: ['finding-1'],
          action: 'fix',
        },
      }, '2026-07-13T01:00:00Z'),
    ]);

    expect(selected.fix).toMatchObject({
      jobId: 'fix-1',
      source: 'remediation',
    });
    expect(selected.fix).not.toHaveProperty('baselineLintJobId');
  });

  it('active manual Research 恢复 research workflow busy', () => {
    const selected = selectRecoverableHealthJobs(snapshot, [
      job('research-manual', 'research', { topic: 'Graph RAG' }, '2026-07-13T01:00:00Z'),
    ]);

    expect(selected.research).toMatchObject({
      jobId: 'research-manual',
      source: 'manual',
    });
  });

  it('active 查询缺失时从 queued plan jobId 恢复 workflow', () => {
    const queuedSnapshot: HealthSnapshot = {
      ...snapshot,
      remediations: {
        ...snapshot.remediations,
        [broken.id]: {
          ...snapshot.remediations[broken.id],
          status: 'queued',
          jobId: 'fix-from-plan',
        },
      },
    };

    expect(selectRecoverableHealthJobs(queuedSnapshot, []).fix).toMatchObject({
      jobId: 'fix-from-plan',
      source: 'remediation',
      blocksAction: true,
    });
  });

  it('刷新后从 awaiting-approval Research plan 恢复完成 job 以读取 run', () => {
    const awaitingSnapshot: HealthSnapshot = {
      ...snapshot,
      remediations: {
        ...snapshot.remediations,
        [gap.id]: {
          ...snapshot.remediations[gap.id],
          status: 'awaiting-approval',
          jobId: 'research-completed',
        },
      },
    };

    expect(selectRecoverableHealthJobs(awaitingSnapshot, []).research).toMatchObject({
      jobId: 'research-completed',
      source: 'remediation',
      blocksAction: false,
    });
  });

  it('候选弹窗关闭后，已完成 Research 恢复项不再占用动作按钮', () => {
    expect([...blockingRecoverableActions({
      fix: {
        jobId: 'fix-running',
        workflow: 'fix',
        source: 'remediation',
        createdAt: '2026-07-21T00:00:00.000Z',
        blocksAction: true,
      },
      research: {
        jobId: 'research-completed',
        workflow: 'research',
        source: 'remediation',
        createdAt: '2026-07-21T00:00:00.000Z',
        blocksAction: false,
      },
    })]).toEqual(['fix']);
  });

  it('ingest 的非法 remediation params 不误判为 re-ingest', () => {
    const invalid = job(
      'ingest-invalid',
      'ingest',
      { remediationContext: { action: 'fix', lintJobId: 'lint-1', findingIds: ['finding-1'] } },
      '2026-07-13T01:00:00Z',
    );

    expect(selectRecoverableHealthJobs(snapshot, [invalid])['re-ingest']).toBeUndefined();
  });

  it('同 workflow 确定性选择 createdAt 最新、同时间 id 最大的 job', () => {
    const selected = selectRecoverableHealthJobs(snapshot, [
      job('fix-a', 'fix', {}, '2026-07-13T01:00:00Z'),
      job('fix-b', 'fix', {}, '2026-07-13T02:00:00Z'),
      job('fix-c', 'fix', {}, '2026-07-13T02:00:00Z'),
    ]);

    expect(selected.fix?.jobId).toBe('fix-c');
  });

  it('workflow 终态同时失效 lint snapshot 与 active jobs', () => {
    expect(healthTerminalInvalidationKeys('subject-1')).toEqual([
      ['lint-latest', 'subject-1'],
      ['health-active-jobs', 'subject-1'],
    ]);
  });
});
