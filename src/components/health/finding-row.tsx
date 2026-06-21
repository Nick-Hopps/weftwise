'use client';

import Link from 'next/link';
import {
  AlertTriangle,
  CircleDashed,
  Clock,
  FileWarning,
  Link2,
  Unlink,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import type { EnrichedLintFinding, LintFinding } from '@/lib/contracts';
import { Tag } from '@/components/ui/tag';
import { findingHref } from './lint-findings';

const TYPE_ICON: Record<LintFinding['type'], LucideIcon> = {
  'broken-link': Unlink,
  orphan: Unplug,
  'missing-frontmatter': FileWarning,
  'stale-source': Clock,
  contradiction: AlertTriangle,
  'missing-crossref': Link2,
  'coverage-gap': CircleDashed,
};

const TYPE_LABEL: Record<LintFinding['type'], string> = {
  'broken-link': 'Broken link',
  orphan: 'Orphan',
  'missing-frontmatter': 'Missing frontmatter',
  'stale-source': 'Stale source',
  contradiction: 'Contradiction',
  'missing-crossref': 'Missing cross-ref',
  'coverage-gap': 'Coverage gap',
};

const SEVERITY_TONE: Record<LintFinding['severity'], 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
};

export function FindingRow({
  finding,
  showSubject = false,
}: {
  finding: EnrichedLintFinding;
  showSubject?: boolean;
}) {
  const Icon = TYPE_ICON[finding.type];
  const href = findingHref(finding);

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
      </div>
    </div>
  );
}
