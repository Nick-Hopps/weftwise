'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
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
} from '@/lib/contracts';
import { Tag } from '@/components/ui/tag';
import { Button, buttonVariants } from '@/components/ui/button';
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
  orphan: 'Orphan',
  'missing-frontmatter': 'Missing frontmatter',
  'stale-source': 'Stale source',
  contradiction: 'Contradiction',
  'missing-crossref': 'Missing cross-ref',
  'coverage-gap': 'Coverage gap',
  'orphan-source': 'Orphan source',
  'thin-page': 'Thin page',
};
const NO_ACTING_ACTIONS = new Set<ExecutableRemediationAction>();

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
  const [deleteArmed, setDeleteArmed] = useState(false);
  const Icon = TYPE_ICON[finding.type];
  const href = findingHref(finding);
  const statusTone = plan?.status === 'failed'
    ? 'danger'
    : plan?.status === 'fixed'
      ? 'success'
      : plan?.status === 'queued'
        ? 'accent'
        : plan?.status === 'awaiting-approval'
          ? 'warning'
          : 'neutral';

  useEffect(() => {
    if (deleting || acting.size > 0) {
      setDeleteArmed((current) => nextDeleteArmed(current, 'acting'));
    }
  }, [acting, deleting]);

  return (
    <div className="flex gap-3 px-3 py-2.5 rounded-md hover:bg-subtle transition-colors">
      <Icon className="h-4 w-4 shrink-0 mt-0.5 text-foreground-tertiary" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Tag tone={SEVERITY_TONE[finding.severity]} size="sm">
            {finding.severity}
          </Tag>
          <span className="text-xs text-foreground-tertiary">{TYPE_LABEL[finding.type]}</span>
          {showSubject && (
            <span className="text-xs text-foreground-tertiary">· {finding.subjectSlug}</span>
          )}
          {href ? (
            <Link href={href} className="text-sm font-medium text-accent hover:underline truncate">
              {finding.pageSlug}
            </Link>
          ) : finding.type === 'orphan-source' ? (
            <span className="text-sm font-medium text-foreground truncate">
              {finding.sourceFilename ?? finding.sourceId}
            </span>
          ) : (
            <span className="text-sm font-medium text-foreground truncate inline-flex items-center">
              {finding.pageSlug}
              <Tag tone="neutral" size="sm" className="ml-1.5">
                suggested page
              </Tag>
            </span>
          )}
        </div>
        <p className="text-sm text-foreground-secondary">{finding.description}</p>
        {finding.suggestedFix && (
          <p className="text-xs text-foreground-tertiary">
            <span className="font-medium">Fix:</span> {finding.suggestedFix}
          </p>
        )}
        {plan ? (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Tag tone={statusTone} size="sm">
                {plan.status}
              </Tag>
              <span className="text-xs text-foreground-tertiary">{plan.workflow}</span>
            </div>
            <p className="text-xs text-foreground-tertiary">{plan.reason}</p>
          </>
        ) : (
          <>
            <Tag tone="neutral" size="sm">plan unavailable</Tag>
            <p className="text-xs text-foreground-tertiary">
              Re-run the health check before choosing a remediation.
            </p>
          </>
        )}
        {plan && plan.actions.length > 0 && (
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            {plan.actions.map((item) =>
              item.type === 'review-source' && item.href ? (
                <Link
                  key={item.type}
                  href={item.href}
                  className={buttonVariants({ intent: 'secondary', size: 'sm' })}
                >
                  {item.label}
                </Link>
              ) : (
                <Button
                  key={item.type}
                  intent="secondary"
                  size="sm"
                  loading={item.type !== 'review-source' && acting.has(item.type)}
                  disabled={item.type !== 'review-source' && busyActions?.has(item.type)}
                  onClick={() => {
                    setDeleteArmed((current) => nextDeleteArmed(current, 'action'));
                    onAction?.(item);
                  }}
                >
                  {item.label}
                </Button>
              ),
            )}
          </div>
        )}
        {plan && onDeleteSource && (
          <div className="mt-1 flex items-center gap-2">
            <Button
              intent={deleteArmed ? 'danger' : 'secondary'}
              size="sm"
              loading={deleting}
              disabled={deleting || acting.size > 0}
              onClick={() => {
                if (!deleteArmed) {
                  setDeleteArmed((current) => nextDeleteArmed(current, 'arm'));
                  return;
                }
                setDeleteArmed((current) => nextDeleteArmed(current, 'action'));
                onDeleteSource();
              }}
            >
              <Trash2 className="h-3 w-3" />
              {deleteArmed ? 'Confirm delete' : 'Delete source'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
