'use client';

import { AlertTriangle, CheckCircle2, Clock3, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PendingActionView } from '@/lib/contracts';

export interface PendingActionCardProps {
  action: PendingActionView;
  busy: boolean;
  onApprove(actionId: string): void;
  onReject(actionId: string): void;
}

const STATUS_LABELS: Record<PendingActionView['status'], string> = {
  pending: 'Awaiting approval',
  approved: 'Approved, preparing execution',
  executing: 'Applying change',
  applied: 'Applied',
  rejected: 'Rejected',
  expired: 'Expired',
  failed: 'Failed',
};

const WORKFLOW_STATUS_LABELS: Record<PendingActionView['status'], string> = {
  ...STATUS_LABELS,
  approved: 'Approved, preparing workflow',
  executing: 'Executing workflow action',
  applied: 'Workflow action applied',
};

function StatusIcon({ status }: { status: PendingActionView['status'] }) {
  if (status === 'applied') return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />;
  if (status === 'rejected' || status === 'failed' || status === 'expired') {
    return <XCircle className="h-4 w-4 text-danger" aria-hidden />;
  }
  return <Clock3 className="h-4 w-4 text-accent" aria-hidden />;
}

export function PendingActionCard({
  action,
  busy,
  onApprove,
  onReject,
}: PendingActionCardProps) {
  const titleId = `pending-action-${action.actionId}`;
  const isPending = action.status === 'pending';
  const title = action.operation === 'history-revert'
    ? 'Proposed history revert'
    : action.operation === 'move'
      ? 'Proposed page move'
    : action.kind === 'workflow'
      ? 'Proposed workflow action'
      : 'Proposed wiki change';

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-lg border border-accent/30 bg-accent-subtle/40 p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <StatusIcon status={action.status} />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-semibold text-foreground">
            {title}
          </h3>
          <p className="mt-1 text-foreground-secondary">{action.summary}</p>
        </div>
      </div>

      {action.affectedPages.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-foreground-secondary">
          {action.affectedPages.map((page) => (
            <li key={`${page.action}:${page.slug}`}>
              <span className="font-medium uppercase">{page.action}</span>{' '}
              <code>{page.slug}</code>
            </li>
          ))}
        </ul>
      )}

      {action.kind === 'workflow' && action.operation === 'workflow-cancel' && (
        <p className="mt-2 text-xs text-foreground-secondary">
          The selected background task will be stopped after approval.
        </p>
      )}

      {action.operation === 'move' && (
        <p className="mt-2 text-xs text-foreground-secondary">
          The canonical page slug and URL will change; the page title stays unchanged.
        </p>
      )}

      {action.kind === 'workflow' && action.operation === 'workflow-research-start' && (
        <p className="mt-2 text-xs text-foreground-secondary">
          Research candidates will still require separate approval before import.
        </p>
      )}

      {action.kind === 'workflow' && ![
        'workflow-cancel',
        'workflow-research-start',
      ].includes(action.operation) && (
        <p className="mt-2 text-xs text-foreground-secondary">
          Final content will be produced after the background task completes.
        </p>
      )}

      {action.warnings.length > 0 && (
        <div className="mt-2 flex items-start gap-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <ul className="list-disc space-y-1 pl-4">
            {action.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
          </ul>
        </div>
      )}

      {action.diff && (
        <details className="mt-2 rounded-md border border-border bg-canvas">
          <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium text-foreground-secondary">
            Review diff
          </summary>
          <pre className="max-h-64 overflow-auto border-t border-border p-2 text-[11px] leading-4 text-foreground">
            {action.diff}
          </pre>
        </details>
      )}

      {action.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {action.error.message}
        </p>
      )}

      {isPending ? (
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            loading={busy}
            onClick={() => onApprove(action.actionId)}
          >
            Approve
          </Button>
          <Button
            intent="outline"
            size="sm"
            disabled={busy}
            onClick={() => onReject(action.actionId)}
          >
            Reject
          </Button>
        </div>
      ) : (
        <p role="status" className="mt-3 text-xs font-medium text-foreground-secondary">
          {(action.kind === 'workflow' ? WORKFLOW_STATUS_LABELS : STATUS_LABELS)[action.status]}
        </p>
      )}
    </section>
  );
}
