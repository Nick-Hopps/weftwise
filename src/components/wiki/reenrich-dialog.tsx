'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { Button } from '@/components/ui/button';

const INVALIDATE_KEYS = ['pages', 'page', 'graph'];

export function ReenrichDialog({
  slug,
  title,
  onClose,
}: {
  slug: string;
  title: string;
  onClose: () => void;
}) {
  const apiFetch = useApiFetch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: subjectId } = useCurrentSubject();

  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { status, latestMessage } = useJobStream(jobId);

  useEffect(() => {
    if (status === 'completed') {
      void (async () => {
        await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
        router.refresh();
        onClose();
      })();
    } else if (status === 'failed') {
      setError('Re-enrich failed — see the job tracker for details.');
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    if (running) return;
    setError(null);
    const res = await apiFetch('/api/re-enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, subjectId }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `HTTP ${res.status}`);
      return;
    }
    const b = (await res.json()) as { jobId: string };
    setJobId(b.jobId);
  }

  const running = jobId !== null && status !== 'failed';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={running ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reenrich-dialog-title"
        className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="reenrich-dialog-title" className="text-sm font-semibold text-foreground">Re-enrich &ldquo;{title}&rdquo;</h2>
        <p className="mt-2 text-sm text-foreground-secondary">
          Re-run the augmentation pass: layers fresh learning callouts onto the existing faithful prose,
          then verifies them. The faithful text is preserved.
        </p>
        {running && (
          <p className="mt-3 text-xs text-foreground-tertiary">{latestMessage || 'Working…'}</p>
        )}
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button intent="ghost" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button intent="primary" onClick={start} loading={running}>
            Re-enrich
          </Button>
        </div>
      </div>
    </div>
  );
}
