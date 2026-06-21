'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { Button } from '@/components/ui/button';

interface PageItem {
  slug: string;
  title: string;
  tags?: string[];
}

const INVALIDATE_KEYS = ['pages', 'page-detail', 'graph', 'search', 'jobs', 'backlinks', 'context', 'frontmatter'];

export function MergeDialog({
  targetSlug,
  targetTitle,
  onClose,
}: {
  targetSlug: string;
  targetTitle: string;
  onClose: () => void;
}) {
  const apiFetch = useApiFetch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: subjectId } = useCurrentSubject();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PageItem | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { status, latestMessage } = useJobStream(jobId);

  const { data: pages = [] } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as PageItem[];
    },
    enabled: !!subjectId,
  });

  const candidates = pages
    .filter((p) => p.slug !== targetSlug && !(p.tags ?? []).includes('meta'))
    .filter((p) => {
      const q = query.trim().toLowerCase();
      return q === '' || p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q);
    });

  useEffect(() => {
    if (status === 'completed') {
      void (async () => {
        await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
        router.refresh();
        onClose();
      })();
    } else if (status === 'failed') {
      setError('Merge failed — see the job tracker for details.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function startMerge() {
    if (!selected) return;
    setError(null);
    const res = await apiFetch('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSlug, sourceSlug: selected.slug, subjectId }),
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
      className="fixed inset-0 flex items-center justify-center bg-black/40 p-4"
      style={{ zIndex: 50 }}
      onClick={running ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface shadow-lg p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-sm font-semibold text-foreground">Merge another page into &quot;{targetTitle}&quot;</h2>
          <p className="mt-1 text-xs text-foreground-secondary">
            The selected page is absorbed into this one and then deleted; references are repointed here. Committed to git (revertable).
          </p>
        </div>

        {running ? (
          <div className="py-6 text-center text-sm text-foreground-secondary">
            {latestMessage || 'Merging…'}
          </div>
        ) : (
          <>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pages to merge in…"
              className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm focus-ring"
            />
            <ul className="max-h-64 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {candidates.length === 0 ? (
                <li className="px-3 py-2 text-sm text-foreground-tertiary">No other pages.</li>
              ) : (
                candidates.map((p) => (
                  <li key={p.slug}>
                    <button
                      onClick={() => setSelected(p)}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                        selected?.slug === p.slug ? 'bg-accent-subtle text-accent-strong' : 'hover:bg-subtle'
                      }`}
                    >
                      {p.title}
                      <span className="ml-2 font-mono text-xs text-foreground-tertiary">{p.slug}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex items-center justify-end gap-2">
              <Button intent="ghost" onClick={onClose}>Cancel</Button>
              <Button intent="primary" disabled={!selected} onClick={startMerge}>
                Merge {selected ? `"${selected.title}"` : ''}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
