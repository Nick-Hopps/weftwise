import { describe, expect, it } from 'vitest';
import type {
  EnrichedLintFinding,
  LintFinding,
  RemediationActionType,
  RemediationStatus,
  RemediationWorkflow,
  SubjectId,
} from '@/lib/contracts';
import { routeFinding } from '../remediation-router';

type ExpectedRoute = {
  workflow: RemediationWorkflow;
  status: RemediationStatus;
  action: RemediationActionType | null;
  sourceId?: string;
};

const EXPECTED_ROUTES = {
  'missing-frontmatter': {
    workflow: 'fix',
    status: 'awaiting-approval',
    action: 'fix',
  },
  'broken-link': {
    workflow: 'fix',
    status: 'awaiting-approval',
    action: 'fix',
  },
  'missing-crossref': {
    workflow: 'fix',
    status: 'awaiting-approval',
    action: 'fix',
  },
  contradiction: {
    workflow: 'fix',
    status: 'awaiting-approval',
    action: 'fix',
  },
  orphan: {
    workflow: 'curate',
    status: 'awaiting-approval',
    action: 'curate',
  },
  'stale-source': {
    workflow: 'source-review',
    status: 'awaiting-approval',
    action: 'review-source',
    sourceId: 'source-1',
  },
  'coverage-gap': {
    workflow: 'research',
    status: 'awaiting-approval',
    action: 'research',
  },
  'orphan-source': {
    workflow: 're-ingest',
    status: 'awaiting-approval',
    action: 're-ingest',
    sourceId: 'source-1',
  },
  'thin-page': {
    workflow: 'research',
    status: 'awaiting-approval',
    action: 'research',
  },
} satisfies Record<LintFinding['type'], ExpectedRoute>;

function finding(
  type: LintFinding['type'],
  overrides: Partial<EnrichedLintFinding> = {},
): EnrichedLintFinding {
  return {
    id: `finding-${type}`,
    subjectId: 'subject-1' as SubjectId,
    subjectSlug: 'general',
    type,
    severity: 'warning',
    pageSlug: 'example-page',
    description: 'Example finding',
    suggestedFix: null,
    ...overrides,
  };
}

describe('routeFinding', () => {
  it.each(
    Object.entries(EXPECTED_ROUTES) as [LintFinding['type'], ExpectedRoute][],
  )('%s 映射到预期处置计划', (type, expected) => {
    const plan = routeFinding(finding(type, { sourceId: expected.sourceId }));

    expect(plan).toMatchObject({
      findingId: `finding-${type}`,
      workflow: expected.workflow,
      status: expected.status,
      actions: expected.action
        ? [{ type: expected.action, destructive: false }]
        : [],
    });
    expect(plan.reason).not.toBe('');
  });

  it('contradiction 明确要求 page/source evidence', () => {
    const plan = routeFinding(finding('contradiction'));

    expect(plan.reason).toMatch(/page.*source.*evidence/i);
  });

  it('coverage-gap 说明研究候选仍需确认', () => {
    const plan = routeFinding(finding('coverage-gap'));

    expect(plan.reason).toMatch(/candidate.*confirm/i);
  });

  it('orphan 只提供 curate，不提供 delete', () => {
    const plan = routeFinding(finding('orphan'));

    expect(plan.actions.map((action) => action.type)).toEqual(['curate']);
    expect(plan.actions.map((action) => String(action.type))).not.toContain('delete');
  });

  it('stale-source 有 sourceId 时提供已编码的 review-source 链接', () => {
    const plan = routeFinding(
      finding('stale-source', { sourceId: ' folder name/source 1?.pdf# ' }),
    );

    expect(plan).toMatchObject({
      findingId: 'finding-stale-source',
      workflow: 'source-review',
      status: 'awaiting-approval',
      actions: [
        {
          type: 'review-source',
          destructive: false,
          href: '/sources/folder%20name%2Fsource%201%3F.pdf%23',
        },
      ],
    });
  });

  it('stale-source 无 sourceId 时跳过且不提供动作', () => {
    const plan = routeFinding(finding('stale-source'));

    expect(plan).toMatchObject({
      workflow: 'source-review',
      status: 'skipped',
      actions: [],
    });
  });

  it.each(['', '   \t\n'])('stale-source 的空白 sourceId %j 被跳过', (sourceId) => {
    const plan = routeFinding(finding('stale-source', { sourceId }));

    expect(plan).toMatchObject({
      workflow: 'source-review',
      status: 'skipped',
      actions: [],
    });
  });

  it('orphan-source 有 sourceId 时只提供 re-ingest，不提供 delete', () => {
    const plan = routeFinding(finding('orphan-source', { sourceId: 'source-1' }));

    expect(plan).toMatchObject({
      workflow: 're-ingest',
      status: 'awaiting-approval',
      actions: [{ type: 're-ingest', destructive: false }],
    });
    expect(plan.actions.map((action) => String(action.type))).not.toContain('delete');
  });

  it('orphan-source 无 sourceId 时跳过且不提供动作', () => {
    const plan = routeFinding(finding('orphan-source'));

    expect(plan).toMatchObject({
      workflow: 're-ingest',
      status: 'skipped',
      actions: [],
    });
  });

  it.each(['', '   \t\n'])('orphan-source 的空白 sourceId %j 被跳过', (sourceId) => {
    const plan = routeFinding(finding('orphan-source', { sourceId }));

    expect(plan).toMatchObject({
      workflow: 're-ingest',
      status: 'skipped',
      actions: [],
    });
  });

  it('thin-page 只提供 research，不暴露 re-enrich', () => {
    const plan = routeFinding(finding('thin-page'));

    expect(plan.actions.map((action) => action.type)).toEqual(['research']);
    expect(plan.actions.map((action) => String(action.type))).not.toContain('re-enrich');
  });

  it('readOnly 清空动作但保留原 workflow、reason 与 awaiting-approval 状态', () => {
    const writable = routeFinding(finding('broken-link'));
    const readOnly = routeFinding(finding('broken-link'), { readOnly: true });

    expect(readOnly).toEqual({
      ...writable,
      actions: [],
    });
    expect(readOnly.status).toBe('awaiting-approval');
  });
});
