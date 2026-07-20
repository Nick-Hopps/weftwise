'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type {
  ResearchCandidateDecision,
  ResearchCandidateIngestStatus,
  ResearchRunView,
} from '@/lib/contracts';
import type { MessageKey } from '@/lib/i18n/messages';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/tag';
import { useI18n } from '@/components/i18n-provider';

const RUN_STATUS_MESSAGE = {
  'awaiting-approval': 'health.researchCandidates.status.awaitingApproval',
  importing: 'health.researchCandidates.status.importing',
  verifying: 'health.researchCandidates.status.verifying',
  completed: 'health.researchCandidates.status.completed',
  partial: 'health.researchCandidates.status.partial',
  failed: 'health.researchCandidates.status.failed',
  dismissed: 'health.researchCandidates.status.dismissed',
  empty: 'health.researchCandidates.status.empty',
} satisfies Record<ResearchRunView['status'], MessageKey>;

const CANDIDATE_DECISION_MESSAGE = {
  approved: 'health.researchCandidates.decision.approved',
  rejected: 'health.researchCandidates.decision.rejected',
} satisfies Record<Exclude<ResearchCandidateDecision, 'pending'>, MessageKey>;

const DELIVERY_STATUS_MESSAGE = {
  pending: 'health.researchCandidates.delivery.pending',
  fetching: 'health.researchCandidates.delivery.fetching',
  queued: 'health.researchCandidates.delivery.queued',
  running: 'health.researchCandidates.delivery.running',
  completed: 'health.researchCandidates.delivery.completed',
  failed: 'health.researchCandidates.delivery.failed',
} satisfies Record<ResearchCandidateIngestStatus, MessageKey>;

export function defaultResearchCandidateIds(run: ResearchRunView): Set<string> {
  return new Set(
    run.candidates
      .filter((candidate) => candidate.decision === 'pending' && candidate.score === 3)
      .map((candidate) => candidate.id),
  );
}

export function researchRunRetryable(run: ResearchRunView): boolean {
  return run.status === 'failed'
    && run.verificationLintJobId === null
    && run.findings.every((finding) => finding.verificationStatus === 'pending')
    && run.approval !== null
    && run.candidates.some((candidate) => candidate.delivery?.status === 'failed');
}

export function ResearchCandidatesDialog({
  run,
  onClose,
  onApprove,
  onDismiss,
  onRetry,
  acting,
}: {
  run: ResearchRunView;
  onClose: () => void;
  onApprove: (candidateIds: string[]) => void;
  onDismiss: () => void;
  onRetry: () => void;
  acting: boolean;
}) {
  const { t } = useI18n();
  const [checked, setChecked] = useState<Set<string>>(
    () => defaultResearchCandidateIds(run),
  );
  useEffect(() => {
    setChecked(defaultResearchCandidateIds(run));
  }, [run]);

  const approvable = run.status === 'awaiting-approval';
  const selectedIds = useMemo(
    () => run.candidates
      .filter((candidate) => candidate.decision === 'pending' && checked.has(candidate.id))
      .map((candidate) => candidate.id),
    [run.candidates, checked],
  );

  function toggle(candidateId: string) {
    if (!approvable) return;
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }

  return (
    <div
      role="presentation"
      onClick={(event) => {
        if (!acting && event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-command flex items-start justify-center pt-[10vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-candidates-title"
        className="w-full max-w-2xl mx-4 flex flex-col bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down max-h-[76vh]"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <h2 id="research-candidates-title" className="text-sm font-semibold text-foreground">
              {t('health.researchCandidates.title', { count: run.candidates.length })}
            </h2>
            <p className="text-xs text-foreground-tertiary">{t(RUN_STATUS_MESSAGE[run.status])}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={acting}
            className="text-foreground-tertiary hover:text-foreground"
            aria-label={t('health.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {run.candidates.length === 0 ? (
            <p className="text-sm text-foreground-tertiary italic py-6 text-center">
              {t('health.researchCandidates.status.empty')}
            </p>
          ) : (
            run.candidates.map((candidate) => (
              <label
                key={candidate.id}
                data-candidate-id={candidate.id}
                className="flex items-start gap-3 px-2 py-2 rounded-md hover:bg-subtle"
              >
                {approvable && candidate.decision === 'pending' && (
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked.has(candidate.id)}
                    onChange={() => toggle(candidate.id)}
                    disabled={acting}
                  />
                )}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={candidate.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-accent hover:underline truncate"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {candidate.title || candidate.url}
                    </a>
                    {candidate.score !== null ? (
                      <Tag
                        tone={candidate.score >= 3 ? 'success' : candidate.score >= 2 ? 'neutral' : 'warning'}
                        size="sm"
                      >
                        {t('health.researchCandidates.score', { score: candidate.score })}
                      </Tag>
                    ) : (
                      <Tag tone="neutral" size="sm">{t('health.unscored')}</Tag>
                    )}
                    {candidate.decision !== 'pending' && (
                      <Tag tone={candidate.decision === 'approved' ? 'success' : 'neutral'} size="sm">
                        {t(CANDIDATE_DECISION_MESSAGE[candidate.decision])}
                      </Tag>
                    )}
                    {candidate.delivery && (
                      <Tag
                        tone={candidate.delivery.status === 'failed'
                          ? 'warning'
                          : candidate.delivery.status === 'completed' ? 'success' : 'neutral'}
                        size="sm"
                      >
                        {t(DELIVERY_STATUS_MESSAGE[candidate.delivery.status])}
                      </Tag>
                    )}
                  </div>
                  <p className="text-xs text-foreground-tertiary truncate">{candidate.url}</p>
                  <p className="text-sm text-foreground-secondary line-clamp-2">{candidate.snippet}</p>
                  {candidate.reason && (
                    <p className="text-xs text-foreground-tertiary italic">{candidate.reason}</p>
                  )}
                  {candidate.delivery?.ingestJobId && (
                    <p className="text-xs font-mono text-foreground-tertiary">
                      {candidate.delivery.ingestJobId}
                    </p>
                  )}
                  {candidate.delivery?.error && (
                    <p className="text-xs text-danger">{candidate.delivery.error.message}</p>
                  )}
                </div>
              </label>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border">
          <span className="text-xs text-foreground-tertiary">
            {approvable
              ? t('health.researchCandidates.selected', { count: selectedIds.length })
              : t(RUN_STATUS_MESSAGE[run.status])}
          </span>
          <div className="flex items-center gap-2">
            {approvable ? (
              <>
                <Button intent="secondary" onClick={onDismiss} disabled={acting}>
                  {t('health.researchCandidates.dismiss')}
                </Button>
                <Button intent="secondary" onClick={onClose} disabled={acting}>
                  {t('health.researchCandidates.cancel')}
                </Button>
                <Button
                  intent="primary"
                  onClick={() => onApprove(selectedIds)}
                  loading={acting}
                  disabled={selectedIds.length === 0}
                >
                  {t('health.researchCandidates.approve', { count: selectedIds.length })}
                </Button>
              </>
            ) : (
              <>
                {researchRunRetryable(run) && (
                  <Button intent="primary" onClick={onRetry} loading={acting}>
                    {t('health.researchCandidates.retryFailedImports')}
                  </Button>
                )}
                <Button intent="secondary" onClick={onClose} disabled={acting}>{t('health.close')}</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
