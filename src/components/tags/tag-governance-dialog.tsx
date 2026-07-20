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
  const actionOptions = [
    { value: 'merge' as const, label: t('tags.action.merge') },
    { value: 'rename' as const, label: t('tags.action.rename') },
    { value: 'delete' as const, label: t('tags.action.delete') },
  ];

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
      setError(data.error ?? t('tags.governance.previewError'));
    } catch {
      setError(t('tags.governance.previewError'));
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
              {t('tags.governance.title')}
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
            options={actionOptions}
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
                placeholder={action === 'merge'
                  ? t('tags.governance.existingTag')
                  : t('tags.governance.newTag')}
              />
              <datalist id={listId}>
                {existingTags.filter((tag) => tag !== sourceTag).map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
              <span className="text-xs text-foreground-tertiary">
                {action === 'merge'
                  ? t('tags.governance.mergeHint')
                  : t('tags.governance.renameHint')}
              </span>
            </label>
          ) : (
            <p className="border-y border-danger-border py-3 text-xs text-danger">
              {t('tags.governance.deleteHint')}
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
            {t('tags.governance.createPreview')}
          </Button>
        </footer>
      </section>
    </div>
  );
}
