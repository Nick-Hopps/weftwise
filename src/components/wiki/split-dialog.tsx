'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { Button } from '@/components/ui/button';

const INVALIDATE_KEYS = ['pages', 'page-detail', 'graph', 'search', 'jobs', 'backlinks', 'context', 'frontmatter'];

export function SplitDialog({
  sourceSlug,
  sourceTitle,
  onClose,
}: {
  sourceSlug: string;
  sourceTitle: string;
  onClose: () => void;
}) {
  const apiFetch = useApiFetch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const [hint, setHint] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { status, latestMessage } = useJobStream(jobId);

  useEffect(() => {
    if (status === 'completed') {
      void (async () => {
        let primarySlug = '';
        try {
          const res = await apiFetch(`/api/jobs/${jobId}`);
          if (res.ok) {
            const job = (await res.json()) as { resultJson?: string };
            const result = JSON.parse(job.resultJson ?? '{}') as { primarySlug?: string };
            primarySlug = result.primarySlug ?? '';
          }
        } catch {
          // fall through to home
        }
        await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
        router.push(
          primarySlug ? `/wiki/${primarySlug}?s=${encodeURIComponent(subjectSlug)}` : '/',
        );
        router.refresh();
        onClose();
      })();
    } else if (status === 'failed') {
      setError('Split failed — see the job tracker for details.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function startSplit() {
    setError(null);
    const res = await apiFetch('/api/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlug, hint: hint.trim() || undefined, subjectId }),
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
    <div
      className="fixed inset-0 z-command flex items-center justify-center bg-black/40 p-4"
      onClick={running ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface shadow-lg p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-sm font-semibold text-foreground">Split "{sourceTitle}" into multiple pages</h2>
          <p className="mt-1 text-xs text-foreground-secondary">
            AI proposes the split; this page is deleted and references are repointed to the primary new page. Committed to git (revertable).
          </p>
        </div>

        {running ? (
          <div className="py-6 text-center text-sm text-foreground-secondary">{latestMessage || 'Splitting…'}</div>
        ) : (
          <>
            <textarea
              autoFocus
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              rows={3}
              placeholder="Optional: how to split / how many pages — leave blank to let AI decide"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus-ring resize-none"
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button intent="ghost" onClick={onClose}>Cancel</Button>
              <Button intent="primary" onClick={startSplit}>Split</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
