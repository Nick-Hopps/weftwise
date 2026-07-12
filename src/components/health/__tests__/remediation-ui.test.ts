import { describe, expect, it } from 'vitest';
import type {
  EnrichedLintFinding,
  HealthSnapshot,
  RemediationActionType,
  RemediationPlan,
} from '@/lib/contracts';
import { actionFindingIds, actionForFinding } from '../remediation-ui';

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
});
