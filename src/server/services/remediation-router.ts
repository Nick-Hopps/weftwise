import type {
  EnrichedLintFinding,
  RemediationAction,
  RemediationPlan,
} from '@/lib/contracts';

function assertNever(value: never): never {
  throw new Error(`Unhandled finding type: ${String(value)}`);
}

function action(
  type: RemediationAction['type'],
  label: string,
  href?: string,
): RemediationAction {
  return href
    ? { type, label, destructive: false, href }
    : { type, label, destructive: false };
}

/**
 * 将 finding 映射为无副作用的处置计划；实际执行仍由调用方在用户批准后触发。
 */
export function routeFinding(
  finding: EnrichedLintFinding,
  options: { readOnly?: boolean } = {},
): RemediationPlan {
  let plan: RemediationPlan;

  switch (finding.type) {
    case 'missing-frontmatter':
      plan = {
        findingId: finding.id,
        workflow: 'fix',
        status: 'awaiting-approval',
        actions: [action('fix', 'Fix issue')],
        reason: 'The fix workflow can restore the required frontmatter after approval.',
      };
      break;
    case 'broken-link':
      plan = {
        findingId: finding.id,
        workflow: 'fix',
        status: 'awaiting-approval',
        actions: [action('fix', 'Fix issue')],
        reason: 'The fix workflow can repair or resolve the broken link after approval.',
      };
      break;
    case 'missing-crossref':
      plan = {
        findingId: finding.id,
        workflow: 'fix',
        status: 'awaiting-approval',
        actions: [action('fix', 'Fix issue')],
        reason: 'The fix workflow can add the missing cross-reference after approval.',
      };
      break;
    case 'contradiction':
      plan = {
        findingId: finding.id,
        workflow: 'fix',
        status: 'awaiting-approval',
        actions: [action('fix', 'Fix issue')],
        reason: 'Resolving a contradiction requires page and source evidence before applying a fix.',
      };
      break;
    case 'orphan':
      plan = {
        findingId: finding.id,
        workflow: 'curate',
        status: 'awaiting-approval',
        actions: [action('curate', 'Curate page')],
        reason: 'Curation can connect this orphan page without offering a destructive delete action.',
      };
      break;
    case 'stale-source':
      plan = finding.sourceId
        ? {
            findingId: finding.id,
            workflow: 'source-review',
            status: 'awaiting-approval',
            actions: [
              action(
                'review-source',
                'Review source',
                `/sources?sourceId=${encodeURIComponent(finding.sourceId)}`,
              ),
            ],
            reason: 'Review the stale source before deciding whether its pages need an update.',
          }
        : {
            findingId: finding.id,
            workflow: 'source-review',
            status: 'skipped',
            actions: [],
            reason: 'Source review is unavailable because this finding has no source ID.',
          };
      break;
    case 'coverage-gap':
      plan = {
        findingId: finding.id,
        workflow: 'research',
        status: 'awaiting-approval',
        actions: [action('research', 'Research topic')],
        reason: 'Research can propose coverage candidates, but each candidate still needs confirmation.',
      };
      break;
    case 'orphan-source':
      plan = finding.sourceId
        ? {
            findingId: finding.id,
            workflow: 're-ingest',
            status: 'awaiting-approval',
            actions: [action('re-ingest', 'Re-ingest source')],
            reason: 'Re-ingesting can reconnect this source without offering a destructive delete action.',
          }
        : {
            findingId: finding.id,
            workflow: 're-ingest',
            status: 'skipped',
            actions: [],
            reason: 'Re-ingest is unavailable because this finding has no source ID.',
          };
      break;
    case 'thin-page':
      plan = {
        findingId: finding.id,
        workflow: 'research',
        status: 'awaiting-approval',
        actions: [action('research', 'Research topic')],
        reason: 'This zero-source thin page needs confirmed research before its content is expanded.',
      };
      break;
    default:
      return assertNever(finding.type);
  }

  // All Subjects 视图只隐藏动作，不改变底层处置判断。
  return options.readOnly ? { ...plan, actions: [] } : plan;
}
