'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, Clock3, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PendingActionView } from '@/lib/contracts';
import { useI18n } from '@/components/i18n-provider';
import type { MessageKey } from '@/lib/i18n/messages';

export interface PendingActionCardProps {
  action: PendingActionView;
  busy: boolean;
  onApprove(actionId: string): void;
  onReject(actionId: string): void;
  affectedPageLimit?: number;
}

const STATUS_LABELS: Record<PendingActionView['status'], MessageKey> = {
  pending: 'chat.action.status.pending',
  approved: 'chat.action.status.approved',
  executing: 'chat.action.status.executing',
  applied: 'chat.action.status.applied',
  rejected: 'chat.action.status.rejected',
  expired: 'chat.action.status.expired',
  failed: 'chat.action.status.failed',
};

const WORKFLOW_STATUS_LABELS: Record<PendingActionView['status'], MessageKey> = {
  ...STATUS_LABELS,
  approved: 'chat.action.status.workflowApproved',
  executing: 'chat.action.status.workflowExecuting',
  applied: 'chat.action.status.workflowApplied',
};

const IMAGE_INSERT_STATUS_LABELS: Record<PendingActionView['status'], MessageKey> = {
  ...WORKFLOW_STATUS_LABELS,
  approved: 'chat.action.status.imageApproved',
  executing: 'chat.action.status.imageExecuting',
  applied: 'chat.action.status.imageApplied',
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
  affectedPageLimit = 8,
}: PendingActionCardProps) {
  const { t } = useI18n();
  const titleId = `pending-action-${action.actionId}`;
  const isPending = action.status === 'pending';
  const shownPages = action.affectedPages.slice(0, affectedPageLimit);
  const hiddenPageCount = action.affectedPages.length - shownPages.length;
  const isImageInsert = action.operation === 'workflow-image-insert-start';
  const title = isImageInsert
    ? t('chat.action.title.illustration')
    : action.operation === 'history-revert'
    ? t('chat.action.title.revert')
    : action.operation === 'move'
      ? t('chat.action.title.move')
    : action.operation === 'tag-batch'
      ? t('chat.action.title.tags')
    : action.kind === 'workflow'
      ? t('chat.action.title.workflow')
      : t('chat.action.title.wiki');

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
          {shownPages.map((page) => (
            <li key={`${page.action}:${page.slug}`}>
              <span className="font-medium uppercase">{page.action}</span>{' '}
              <code>{page.slug}</code>
            </li>
          ))}
          {hiddenPageCount > 0 && (
            <li className="text-foreground-tertiary">{t('chat.action.morePages', { count: hiddenPageCount })}</li>
          )}
        </ul>
      )}

      {action.kind === 'workflow' && action.operation === 'workflow-cancel' && (
        <p className="mt-2 text-xs text-foreground-secondary">
          {t('chat.action.cancelHint')}
        </p>
      )}

      {action.operation === 'move' && (
        <p className="mt-2 text-xs text-foreground-secondary">
          {t('chat.action.moveHint')}
        </p>
      )}

      {action.kind === 'workflow' && action.operation === 'workflow-research-start' && (
        <p className="mt-2 text-xs text-foreground-secondary">
          {t('chat.action.researchHint')}
        </p>
      )}

      {isImageInsert && action.imageInsert && (
        <div className="mt-3 space-y-2 border-t border-border-subtle pt-3 text-xs">
          <div>
            <p className="font-medium text-foreground-secondary">{t('chat.action.selectedMarkdown')}</p>
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-foreground">
              {action.imageInsert.selection}
            </pre>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-foreground-secondary">
            <dt className="font-medium">{t('chat.action.prompt')}</dt>
            <dd className="break-words text-foreground">{action.imageInsert.prompt}</dd>
            <dt className="font-medium">{t('chat.action.altText')}</dt>
            <dd className="break-words text-foreground">{action.imageInsert.alt}</dd>
            {action.imageInsert.aspectRatio && (
              <>
                <dt className="font-medium">{t('chat.action.aspectRatio')}</dt>
                <dd className="text-foreground">{action.imageInsert.aspectRatio}</dd>
              </>
            )}
            {action.imageInsert.style && (
              <>
                <dt className="font-medium">{t('chat.action.style')}</dt>
                <dd className="break-words text-foreground">{action.imageInsert.style}</dd>
              </>
            )}
          </dl>
          <p className="text-foreground-secondary">
            {t('chat.action.imageHint')}
          </p>
        </div>
      )}

      {action.kind === 'workflow' && ![
        'workflow-cancel',
        'workflow-research-start',
        'workflow-image-insert-start',
      ].includes(action.operation) && (
        <p className="mt-2 text-xs text-foreground-secondary">
          {t('chat.action.workflowHint')}
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
            {t('chat.action.reviewDiff')}
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
            {t('chat.action.approve')}
          </Button>
          <Button
            intent="outline"
            size="sm"
            disabled={busy}
            onClick={() => onReject(action.actionId)}
          >
            {t('chat.action.reject')}
          </Button>
        </div>
      ) : (
        <p role="status" className="mt-3 text-xs font-medium text-foreground-secondary">
          {t((isImageInsert
            ? IMAGE_INSERT_STATUS_LABELS
            : action.kind === 'workflow'
              ? WORKFLOW_STATUS_LABELS
              : STATUS_LABELS)[action.status])}
        </p>
      )}
    </section>
  );
}
