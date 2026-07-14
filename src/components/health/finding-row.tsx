'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ChevronDown,
  CircleDashed,
  Clock,
  FileMinus,
  FileWarning,
  FileX,
  Link2,
  Trash2,
  Unlink,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import type {
  EnrichedLintFinding,
  LintFinding,
  RemediationAction,
  RemediationPlan,
  RemediationStatus,
} from '@/lib/contracts';
import { Tag } from '@/components/ui/tag';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { findingHref, SEVERITY_TONE } from './lint-findings';
import { nextDeleteArmed, type ExecutableRemediationAction } from './remediation-ui';

const TYPE_ICON: Record<LintFinding['type'], LucideIcon> = {
  'broken-link': Unlink,
  orphan: Unplug,
  'missing-frontmatter': FileWarning,
  'stale-source': Clock,
  contradiction: AlertTriangle,
  'missing-crossref': Link2,
  'coverage-gap': CircleDashed,
  'orphan-source': FileX,
  'thin-page': FileMinus,
};

const TYPE_LABEL: Record<LintFinding['type'], string> = {
  'broken-link': 'Broken link',
  orphan: 'Orphan page',
  'missing-frontmatter': 'Missing frontmatter',
  'stale-source': 'Stale source',
  contradiction: 'Contradiction',
  'missing-crossref': 'Missing cross-reference',
  'coverage-gap': 'Coverage gap',
  'orphan-source': 'Orphan source',
  'thin-page': 'Thin page',
};

const STATUS_LABEL: Record<RemediationStatus, string> = {
  'awaiting-approval': 'Needs action',
  queued: 'In progress',
  fixed: 'Resolved',
  skipped: 'No change',
  failed: 'Needs review',
};

const STATUS_DOT: Record<RemediationStatus, string> = {
  'awaiting-approval': 'bg-warning',
  queued: 'bg-accent',
  fixed: 'bg-success',
  skipped: 'bg-foreground-tertiary',
  failed: 'bg-danger',
};

const WORKFLOW_LABEL: Record<RemediationPlan['workflow'], string> = {
  fix: 'Automatic fix',
  curate: 'Structure curation',
  research: 'Guided research',
  're-ingest': 'Source ingestion',
  'source-review': 'Source review',
};

const NO_ACTING_ACTIONS = new Set<ExecutableRemediationAction>();

export function remediationStatusLabel(status: RemediationStatus): string {
  return STATUS_LABEL[status];
}

export function findingTypeLabel(type: LintFinding['type']): string {
  return TYPE_LABEL[type];
}

export function FindingRow({
  finding,
  plan,
  showSubject = false,
  acting = NO_ACTING_ACTIONS,
  deleting = false,
  busyActions,
  onAction,
  onDeleteSource,
}: {
  finding: EnrichedLintFinding;
  plan?: RemediationPlan;
  showSubject?: boolean;
  acting?: ReadonlySet<ExecutableRemediationAction>;
  deleting?: boolean;
  busyActions?: ReadonlySet<ExecutableRemediationAction>;
  onAction?: (action: RemediationAction) => void;
  onDeleteSource?: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const Icon = TYPE_ICON[finding.type];
  const href = findingHref(finding);
  const planActionBusy = plan?.actions.some(
    (action) => action.type !== 'review-source' && busyActions?.has(action.type),
  ) ?? false;
  const hasDetails = Boolean(finding.suggestedFix || plan?.reason);

  useEffect(() => {
    if (deleting || acting.size > 0 || planActionBusy) {
      setDeleteArmed((current) => nextDeleteArmed(current, 'acting'));
    }
  }, [acting, deleting, planActionBusy]);

  return (
    <article className="group bg-surface transition-colors hover:bg-subtle/40">
      <div className="grid min-w-0 gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-5">
        <div className="flex min-w-0 gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-subtle text-foreground-tertiary">
            <Icon className="h-4 w-4" aria-hidden />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Tag tone={SEVERITY_TONE[finding.severity]} size="sm">
                {finding.severity}
              </Tag>
              <span className="text-xs font-medium text-foreground-secondary">
                {TYPE_LABEL[finding.type]}
              </span>
              {showSubject && (
                <span className="text-xs text-foreground-tertiary">{finding.subjectSlug}</span>
              )}
            </div>

            <div className="mt-1 min-w-0">
              {href ? (
                <Link
                  href={href}
                  className="inline-block max-w-full truncate text-sm font-semibold text-foreground hover:text-accent-strong hover:underline"
                >
                  {finding.pageSlug}
                </Link>
              ) : finding.type === 'orphan-source' ? (
                <span className="block truncate text-sm font-semibold text-foreground">
                  {finding.sourceFilename ?? finding.sourceId}
                </span>
              ) : (
                <span className="inline-flex max-w-full items-center gap-2 text-sm font-semibold text-foreground">
                  <span className="truncate">{finding.pageSlug}</span>
                  <span className="shrink-0 text-xs font-normal text-foreground-tertiary">
                    Suggested page
                  </span>
                </span>
              )}
            </div>

            <p className="mt-1 line-clamp-2 text-sm leading-5 text-foreground-secondary">
              {finding.description}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pl-11 sm:min-w-[230px] sm:justify-end sm:pl-0">
          <div className="min-w-[96px]">
            {plan ? (
              <>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[plan.status])} />
                  {STATUS_LABEL[plan.status]}
                </span>
                <span className="mt-0.5 block text-xs text-foreground-tertiary">
                  {WORKFLOW_LABEL[plan.workflow]}
                </span>
              </>
            ) : (
              <>
                <span className="text-xs font-medium text-foreground-secondary">Check required</span>
                <span className="mt-0.5 block text-xs text-foreground-tertiary">Plan unavailable</span>
              </>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {plan?.actions.map((item) =>
              item.type === 'review-source' && item.href ? (
                <Link
                  key={item.type}
                  href={item.href}
                  aria-disabled={deleting}
                  tabIndex={deleting ? -1 : undefined}
                  onClick={(event) => {
                    if (deleting) event.preventDefault();
                  }}
                  className={cn(
                    buttonVariants({ intent: 'outline', size: 'sm' }),
                    deleting && 'pointer-events-none opacity-50',
                  )}
                >
                  {item.label}
                </Link>
              ) : (
                <Button
                  key={item.type}
                  intent="outline"
                  size="sm"
                  loading={item.type !== 'review-source' && acting.has(item.type)}
                  disabled={
                    deleting
                    || (item.type !== 'review-source' && busyActions?.has(item.type))
                  }
                  onClick={() => {
                    setDeleteArmed((current) => nextDeleteArmed(current, 'action'));
                    onAction?.(item);
                  }}
                >
                  {item.label}
                </Button>
              ),
            )}

            {hasDetails && (
              <Button
                type="button"
                intent="ghost"
                size="sm"
                className="w-6 px-0"
                aria-label={detailsOpen ? 'Hide finding details' : 'Show finding details'}
                aria-expanded={detailsOpen}
                title={detailsOpen ? 'Hide details' : 'Show details'}
                onClick={() => setDetailsOpen((current) => !current)}
              >
                <ChevronDown
                  className={cn('h-3.5 w-3.5 transition-transform duration-base', detailsOpen && 'rotate-180')}
                  aria-hidden
                />
              </Button>
            )}
          </div>
        </div>
      </div>

      {detailsOpen && hasDetails && (
        <div className="animate-slide-down border-t border-border-subtle bg-canvas/60 px-4 py-3 pl-16 sm:grid sm:grid-cols-2 sm:gap-8">
          {finding.suggestedFix && (
            <div>
              <h3 className="text-xs font-medium text-foreground">Recommended change</h3>
              <p className="mt-1 text-xs leading-5 text-foreground-secondary">{finding.suggestedFix}</p>
            </div>
          )}
          {plan?.reason && (
            <div className={cn(finding.suggestedFix && 'mt-3 sm:mt-0')}>
              <h3 className="text-xs font-medium text-foreground">Why this action</h3>
              <p className="mt-1 text-xs leading-5 text-foreground-secondary">{plan.reason}</p>
            </div>
          )}
        </div>
      )}

      {!plan && (
        <p className="border-t border-border-subtle bg-canvas/60 px-4 py-2 pl-16 text-xs text-foreground-tertiary">
          Re-run the health check before choosing a remediation.
        </p>
      )}

      {plan && onDeleteSource && (
        <div className="flex justify-end border-t border-border-subtle bg-canvas/60 px-4 py-2">
          <Button
            intent={deleteArmed ? 'danger' : 'ghost'}
            size="sm"
            loading={deleting}
            disabled={deleting || acting.size > 0 || planActionBusy}
            onClick={() => {
              if (!deleteArmed) {
                setDeleteArmed((current) => nextDeleteArmed(current, 'arm'));
                return;
              }
              setDeleteArmed((current) => nextDeleteArmed(current, 'action'));
              onDeleteSource();
            }}
          >
            <Trash2 className="h-3 w-3" aria-hidden />
            {deleteArmed ? 'Confirm delete' : 'Delete source'}
          </Button>
        </div>
      )}
    </article>
  );
}
