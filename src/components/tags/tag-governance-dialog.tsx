'use client';

import { useEffect, useId, useState } from 'react';
import { Eye, X } from 'lucide-react';
import { useApiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import type { PendingActionView, TagBatchAction } from '@/lib/contracts';
import { useI18n } from '@/components/i18n-provider';

const ACTION_OPTIONS = [
  { value: 'merge' as const, label: 'Merge' },
  { value: 'rename' as const, label: 'Rename' },
  { value: 'delete' as const, label: 'Delete' },
];

export function TagGovernanceDialog({
  sourceTag,
  suggestedTarget,
  existingTags,
  subjectId,
  onClose,
  onCreated,
}: {
  sourceTag: string;
  suggestedTarget?: string;
  existingTags: string[];
  subjectId: string;
  onClose(): void;
  onCreated(action: PendingActionView): void;
}) {
  const { t } = useI18n();
  const apiFetch = useApiFetch();
  const listId = useId();
  const [action, setAction] = useState<TagBatchAction>(suggestedTarget ? 'merge' : 'rename');
  const [targetTag, setTargetTag] = useState(suggestedTarget ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  async function createPreview() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/tag-actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectId,
          action,
          sourceTag,
          ...(action !== 'delete' ? { targetTag } : {}),
        }),
      });
      const data = await response.json() as { action?: PendingActionView; error?: string };
      if (data.action) {
        onCreated(data.action);
        onClose();
        return;
      }
      setError(data.error ?? 'Unable to create the preview.');
    } catch {
      setError('Unable to create the preview.');
    } finally {
      setBusy(false);
    }
  }

  const targetRequired = action !== 'delete';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-governance-title"
        className="w-full max-w-md rounded-lg border border-border bg-surface shadow-lg"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id="tag-governance-title" className="text-sm font-semibold text-foreground">
              Manage tag
            </h2>
            <p className="mt-0.5 truncate text-xs text-foreground-tertiary">#{sourceTag}</p>
          </div>
          <IconButton size="sm" onClick={onClose} disabled={busy} aria-label={t('tags.close')} title={t('tags.close')}>
            <X aria-hidden />
          </IconButton>
        </header>

        <div className="space-y-5 px-4 py-4">
          <Segmented
            value={action}
            options={ACTION_OPTIONS}
            onChange={(value) => {
              setAction(value);
              setError(null);
            }}
            columns={3}
            aria-label={t('tags.action')}
          />

          {targetRequired ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground-secondary">{t('tags.target')}</span>
              <Input
                autoFocus
                list={listId}
                value={targetTag}
                onChange={(event) => setTargetTag(event.target.value)}
                placeholder={action === 'merge' ? 'Existing tag' : 'New tag name'}
              />
              <datalist id={listId}>
                {existingTags.filter((tag) => tag !== sourceTag).map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
              <span className="text-xs text-foreground-tertiary">
                {action === 'merge'
                  ? 'The target must already exist in this subject.'
                  : 'The new name must not already be in use.'}
              </span>
            </label>
          ) : (
            <p className="border-y border-danger-border py-3 text-xs text-danger">
              This removes the tag from every matching page. Pages and content remain unchanged.
            </p>
          )}

          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button intent="ghost" size="sm" disabled={busy} onClick={onClose}>{t('tags.cancel')}</Button>
          <Button
            size="sm"
            loading={busy}
            disabled={targetRequired && !targetTag.trim()}
            onClick={() => void createPreview()}
          >
            <Eye className="h-3.5 w-3.5" aria-hidden />
            Create preview
          </Button>
        </footer>
      </section>
    </div>
  );
}
