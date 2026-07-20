'use client';

import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import type { HistoryEntry } from '@/lib/contracts';
import { useI18n } from '@/components/i18n-provider';

export function RevertButton({ entry }: { entry: HistoryEntry }) {
  const { t } = useI18n();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: subjectId } = useCurrentSubject();
  const [confirming, setConfirming] = useState(false);

  const revert = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/history/${entry.id}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? t('history.revertFailed'));
      }
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['history'] });
      await queryClient.invalidateQueries({ queryKey: ['pages'] });
      router.refresh();
      setConfirming(false);
    },
  });

  if (entry.status === 'reverted') {
    return <span className="text-xs text-foreground-tertiary">{t('history.alreadyReverted')}</span>;
  }

  if (!confirming) {
    return (
      <Button intent="ghost" size="sm" onClick={() => setConfirming(true)}>
        <Undo2 className="h-3.5 w-3.5" />
        {t('history.revert')}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-subtle p-3 text-xs">
      <p className="text-foreground-secondary">
        {t('history.revertDescription')}
      </p>
      {revert.isError && (
        <p className="text-red-600 dark:text-red-400">{(revert.error as Error).message}</p>
      )}
      <div className="flex gap-2">
        <Button
          intent="primary"
          size="sm"
          disabled={revert.isPending}
          onClick={() => revert.mutate()}
        >
          {revert.isPending ? t('history.reverting') : t('history.confirmRevert')}
        </Button>
        <Button intent="ghost" size="sm" disabled={revert.isPending} onClick={() => setConfirming(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
