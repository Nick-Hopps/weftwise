import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  EnrichedLintFinding,
  HealthSnapshot,
  RemediationActionType,
  RemediationPlan,
} from '@/lib/contracts';
import {
  actionFindingIds,
  actionForFinding,
  createActionGate,
  isHealthOriginCurrent,
  nextDeleteArmed,
  readResearchCandidates,
  recentOutcomeBannerTone,
  recentOutcomeCounts,
  researchBacklogPatchBody,
} from '../remediation-ui';
import { FindingRow } from '../finding-row';

vi.mock('@/components/ui/tag', async () => {
  const ReactModule = await import('react');
  return {
    Tag: ({ children }: React.PropsWithChildren) => ReactModule.createElement('span', null, children),
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

    expect(html).toContain('plan unavailable');
    expect(html).toContain('Re-run the health check');
    expect(html).not.toContain('Fix issues');
  });

  it('acting 变化或动作点击会解除删除确认状态', () => {
    expect(nextDeleteArmed(false, 'arm')).toBe(true);
    expect(nextDeleteArmed(true, 'acting')).toBe(false);
    expect(nextDeleteArmed(true, 'action')).toBe(false);
  });

  it('Research 结果读取区分 HTTP、响应 JSON 与 resultJson 错误', async () => {
    await expect(readResearchCandidates(new Response('', { status: 503 })))
      .rejects.toThrow('Research result request failed (503).');
    await expect(readResearchCandidates(new Response('{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))).rejects.toThrow('Research result response is invalid.');
    await expect(readResearchCandidates(Response.json({ resultJson: '{' })))
      .rejects.toThrow('Research result is invalid.');
    await expect(readResearchCandidates(Response.json({
      resultJson: JSON.stringify({ candidates: [{ title: 'Result' }] }),
    }))).resolves.toEqual([{ title: 'Result' }]);
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
});
