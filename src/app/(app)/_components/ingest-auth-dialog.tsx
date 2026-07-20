'use client';

import React, { useEffect, useState } from 'react';
import {
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import {
  buildUrlAuthSubmissionBody,
  type UrlAuthChallenge,
  type UrlAuthSubmissionResult,
} from '@/lib/ingest-auth';
import { useUIStore } from '@/stores/ui-store';
import { useI18n } from '@/components/i18n-provider';
import { Button, buttonVariants } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

export function IngestAuthDialog({
  open,
  jobId,
  subjectId: jobSubjectId,
  challenge,
  onClose,
  onAuthenticated,
}: {
  open: boolean;
  jobId: string;
  subjectId?: string | null;
  challenge: UrlAuthChallenge | null;
  onClose: () => void;
  onAuthenticated: (result: UrlAuthSubmissionResult) => void;
}) {
  const { t } = useI18n();
  const [cookie, setCookie] = useState('');
  const [authorization, setAuthorization] = useState('');
  const [reveal, setReveal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open, submitting]);

  useEffect(() => {
    if (open) return;
    setCookie('');
    setAuthorization('');
    setReveal(false);
    setError(null);
  }, [open]);

  if (!open || !challenge) return null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || (!cookie.trim() && !authorization.trim())) return;
    setSubmitting(true);
    setError(null);
    try {
      const subjectId = jobSubjectId ?? useUIStore.getState().currentSubjectId;
      const response = await apiFetch(`/api/jobs/${jobId}/url-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildUrlAuthSubmissionBody({
          subjectId,
          cookie,
          authorization,
        })),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Authentication failed (${response.status})`);
      }
      onAuthenticated(await response.json() as UrlAuthSubmissionResult);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = `ingest-auth-title-${jobId}`;
  const secretType = reveal ? 'text' : 'password';

  return (
    <div
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
      className="fixed inset-0 z-command flex items-start justify-center bg-overlay/40 pt-[12vh] backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mx-4 flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg animate-slide-down"
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            <LockKeyhole className="h-4 w-4 shrink-0 text-accent" aria-hidden />
            <h2 id={titleId} className="truncate text-sm font-semibold text-foreground">
              {t('ingest.auth.title')}
            </h2>
          </div>
          <IconButton
            type="button"
            size="sm"
            onClick={onClose}
            disabled={submitting}
            aria-label={t('common.close')}
            data-tip={t('common.close')}
            className="tip tip-l"
          >
            <X />
          </IconButton>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-subtle px-3 py-2">
            <code className="min-w-0 truncate font-mono text-xs text-foreground">
              {challenge.authOrigin}
            </code>
            <a
              href={challenge.authOrigin}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ intent: 'outline', size: 'sm' }), 'shrink-0')}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t('ingest.auth.openPage')}
            </a>
          </div>

          <CredentialField
            id={`ingest-auth-cookie-${jobId}`}
            label={t('ingest.auth.cookie')}
            value={cookie}
            onChange={setCookie}
            type={secretType}
            placeholder={t('ingest.auth.cookiePlaceholder')}
            reveal={reveal}
            onToggleReveal={() => setReveal((value) => !value)}
            disabled={submitting}
          />

          <CredentialField
            id={`ingest-auth-authorization-${jobId}`}
            label={t('ingest.auth.authorization')}
            optional={t('ingest.auth.optional')}
            value={authorization}
            onChange={setAuthorization}
            type={secretType}
            placeholder={t('ingest.auth.authorizationPlaceholder')}
            reveal={reveal}
            onToggleReveal={() => setReveal((value) => !value)}
            disabled={submitting}
          />

          <div className="flex items-center gap-2 text-[11px] text-foreground-tertiary">
            <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{t('ingest.auth.security')}</span>
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-danger-border/40 bg-danger-bg px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button type="button" intent="ghost" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              intent="primary"
              loading={submitting}
              disabled={!cookie.trim() && !authorization.trim()}
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden />
              {t('ingest.auth.submit')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CredentialField({
  id,
  label,
  optional,
  value,
  onChange,
  type,
  placeholder,
  reveal,
  onToggleReveal,
  disabled,
}: {
  id: string;
  label: string;
  optional?: string;
  value: string;
  onChange: (value: string) => void;
  type: 'text' | 'password';
  placeholder: string;
  reveal: boolean;
  onToggleReveal: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const revealLabel = reveal ? t('ingest.auth.hide') : t('ingest.auth.show');
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-foreground-secondary">
        {label}
        {optional && (
          <span className="ml-1 font-normal text-foreground-tertiary">({optional})</span>
        )}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          className="font-mono text-xs"
        />
        <IconButton
          type="button"
          intent="outline"
          onClick={onToggleReveal}
          disabled={disabled}
          aria-label={revealLabel}
          data-tip={revealLabel}
          className="tip tip-l shrink-0"
        >
          {reveal ? <EyeOff /> : <Eye />}
        </IconButton>
      </div>
    </div>
  );
}
