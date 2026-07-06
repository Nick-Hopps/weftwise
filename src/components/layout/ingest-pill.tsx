'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useJobStream, type JobStreamEvent } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';

const PHASES = ['Parse', 'Plan', 'Write', 'Enrich', 'Verify', 'Commit'];

function payloadOf(evt: JobStreamEvent): Record<string, unknown> {
  const inner = evt.data?.data;
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {};
}

/** Furthest pipeline phase any event has reached (mirrors ingest-live-view). */
function currentPhase(events: JobStreamEvent[]): number {
  let max = 0;
  for (const e of events) {
    const t = e.type;
    const skillId = typeof payloadOf(e).skillId === 'string' ? (payloadOf(e).skillId as string) : '';
    let idx: number | null = null;
    if (t === 'ingest:committing') idx = 5;
    else if (t === 'ingest:verify' || skillId.startsWith('ingest-verifier')) idx = 4;
    else if (skillId === 'ingest-enricher') idx = 3;
    else if (skillId === 'ingest-writer') idx = 2;
    else if (t === 'ingest:planning' || skillId === 'ingest-planner') idx = 1;
    else if (
      t === 'ingest:parsing' ||
      t === 'ingest:chunking' ||
      t === 'ingest:start' ||
      t === 'ingest:resuming' ||
      skillId === 'ingest-chunk-summarizer'
    ) {
      idx = 0;
    }
    if (idx !== null && idx > max) max = idx;
  }
  return max;
}

/**
 * Background-ingest progress pill shown in the header while an ingest runs.
 * Clicking it opens the ingest workspace, where the live view lives.
 */
export function IngestPill() {
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(null);
  // Force a re-subscribe when a tracked job restarts (a retry keeps the same id).
  const [reconnectKey, setReconnectKey] = useState(0);
  const { events, status } = useJobStream(jobId, reconnectKey);

  const check = useCallback(async () => {
    if (jobId) return; // already tracking one
    const subjectId = useUIStore.getState().currentSubjectId;
    try {
      const qs = subjectId ? `&subjectId=${encodeURIComponent(subjectId)}` : '';
      const res = await apiFetch(`/api/jobs?status=running&type=ingest${qs}`);
      if (!res.ok) return;
      const jobs = (await res.json()) as Array<{ id: string }>;
      if (Array.isArray(jobs) && jobs.length > 0) setJobId(jobs[jobs.length - 1].id);
    } catch {
      /* ignore */
    }
  }, [jobId]);

  useEffect(() => {
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [check]);

  useEffect(() => {
    const onStarted = (e: Event) => {
      const detail = (e as CustomEvent<{ jobId: string }>).detail;
      if (detail?.jobId) {
        setJobId(detail.jobId);
        setReconnectKey((k) => k + 1);
      }
    };
    window.addEventListener('wiki:job-started', onStarted);
    return () => window.removeEventListener('wiki:job-started', onStarted);
  }, []);

  // Drop the tracked job shortly after it settles so the pill clears.
  useEffect(() => {
    if (status !== 'completed' && status !== 'failed') return;
    const t = setTimeout(() => setJobId(null), 2000);
    return () => clearTimeout(t);
  }, [status]);

  if (!jobId || status !== 'streaming') return null;

  const idx = currentPhase(events);
  const pct = Math.min(97, Math.round(((idx + 0.5) / PHASES.length) * 100));

  return (
    <button
      type="button"
      onClick={() => router.push('/ingest')}
      aria-label="Open ingest"
      data-tip="Open ingest"
      className="tip tip-b hidden shrink-0 items-center gap-2 h-8 rounded-full border border-accent/30 bg-accent/[0.08] pl-2 pr-2.5 text-xs text-accent-strong transition-colors hover:bg-accent/[0.13] focus-ring sm:flex"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
      <span className="font-medium whitespace-nowrap">{PHASES[idx]}…</span>
      <span className="font-mono tabular-nums text-foreground-tertiary">{pct}%</span>
    </button>
  );
}
