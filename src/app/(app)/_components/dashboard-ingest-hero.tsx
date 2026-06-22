'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CircleCheck,
  ClipboardPaste,
  FileUp,
  GitCommitHorizontal,
  Layers,
  Link2,
  ListChecks,
  Loader2,
  Maximize2,
  PenLine,
  Plus,
  ScanText,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useJobStream } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';
import { IngestLiveView } from './ingest-live-view';
import type { CheckpointProgress, Job } from '@/lib/contracts';

/** The six agent phases, shown as a "what the agent does" preview while idle. */
const PIPELINE: ReadonlyArray<{ label: string; Icon: LucideIcon }> = [
  { label: 'Parse', Icon: ScanText },
  { label: 'Plan', Icon: ListChecks },
  { label: 'Write', Icon: PenLine },
  { label: 'Link', Icon: Link2 },
  { label: 'Lint', Icon: ShieldCheck },
  { label: 'Commit', Icon: GitCommitHorizontal },
];

export function DashboardIngestHero() {
  const queryClient = useQueryClient();
  const [paste, setPaste] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [checkpointProgress, setCheckpointProgress] = useState<CheckpointProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');
  const [filenameInput, setFilenameInput] = useState('');
  const [sourceName, setSourceName] = useState<string>('');
  const [createdPages, setCreatedPages] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { events, status, latestMessage } = useJobStream(jobId, reconnectKey);

  const isProcessing = jobId !== null && status === 'streaming';
  const isDone = status === 'completed';
  const isFailed = status === 'failed';
  const phase: 'idle' | 'running' | 'done' | 'failed' = isProcessing
    ? 'running'
    : isDone
      ? 'done'
      : isFailed
        ? 'failed'
        : 'idle';

  // Aggregate prompt-cache hits across agent runs so the saving is visible.
  const cacheStats = useMemo(() => {
    let cacheHit = 0;
    let promptIn = 0;
    for (const e of events) {
      if (e.type !== 'agent:step') continue;
      // Emitted payload is nested under evt.data.data by the SSE bridge.
      const d = e.data?.data as { kind?: string; tokensIn?: number; cacheHitTokens?: number } | undefined;
      if (d?.kind !== 'final') continue;
      if (typeof d.tokensIn === 'number') promptIn += d.tokensIn;
      if (typeof d.cacheHitTokens === 'number') cacheHit += d.cacheHitTokens;
    }
    const pct = promptIn > 0 ? Math.round((cacheHit / promptIn) * 100) : 0;
    return { cacheHit, promptIn, pct };
  }, [events]);

  useEffect(() => {
    if (!isDone) return;
    queryClient.invalidateQueries({ queryKey: ['pages'] });
  }, [isDone, queryClient]);

  useEffect(() => {
    if (!isDone) return;
    // The worker emits the IngestResult on `job:completed`; older builds used
    // `ingest:complete` — accept either.
    const doneEvent = events.find((e) => e.type === 'job:completed' || e.type === 'ingest:complete');
    const result = (doneEvent?.data?.data as { result?: { pagesCreated?: string[] } } | undefined)?.result;
    if (result?.pagesCreated) setCreatedPages(result.pagesCreated);
  }, [isDone, events]);

  const reset = () => {
    setJobId(null);
    setError(null);
    setCreatedPages([]);
    setTextInput('');
    setFilenameInput('');
    setSourceName('');
    setPaste(false);
    setShowLog(false);
    setLiveOpen(false);
    setCheckpointProgress(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // Manual retry: requeue the same job, then force an SSE reconnect for that id.
  const handleRetry = useCallback(async () => {
    if (!jobId) return;
    setRetrying(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Retry failed (${res.status})`);
      }
      setCheckpointProgress(null);
      setReconnectKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [jobId]);

  // After a failure, fetch this job's checkpoint progress for the retry label.
  useEffect(() => {
    if (status !== 'failed' || !jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/jobs/${jobId}`);
        if (!res.ok) return;
        const job = (await res.json()) as { checkpointProgress?: CheckpointProgress | null };
        if (!cancelled) setCheckpointProgress(job.checkpointProgress ?? null);
      } catch {
        /* silent — the progress label is a nicety */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, jobId]);

  // On mount, restore the most recent resumable failed ingest for this subject.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const subjectId = useUIStore.getState().currentSubjectId;
      if (!subjectId) return;
      try {
        // Reflect an in-progress background ingest if the user returns mid-run.
        const runningRes = await apiFetch(
          `/api/jobs?status=running&type=ingest&subjectId=${encodeURIComponent(subjectId)}`,
        );
        if (runningRes.ok) {
          const running = (await runningRes.json()) as Job[];
          if (running.length > 0) {
            if (!cancelled) setJobId(running[running.length - 1].id);
            return;
          }
        }
        const res = await apiFetch(
          `/api/jobs?status=failed&type=ingest&subjectId=${encodeURIComponent(subjectId)}`,
        );
        if (!res.ok) return;
        const jobs = (await res.json()) as Array<Job & { checkpointProgress: CheckpointProgress | null }>;
        const resumable = jobs.filter((j) => j.checkpointProgress);
        if (resumable.length === 0) return;
        const latest = resumable[resumable.length - 1]; // listJobs is createdAt-ascending
        if (cancelled) return;
        setCheckpointProgress(latest.checkpointProgress);
        setJobId(latest.id);
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Resume is attempted once, on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadFile = useCallback(async (file: File) => {
    setError(null);
    setCreatedPages([]);
    setUploading(true);
    setSourceName(file.name);
    try {
      const subjectId = useUIStore.getState().currentSubjectId;
      const formData = new FormData();
      formData.append('file', file);
      if (subjectId) formData.append('subjectId', subjectId);
      const res = await apiFetch('/api/ingest', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Upload failed (${res.status})`);
      }
      const data = await res.json();
      setJobId(data.jobId);
      setLiveOpen(true);
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const handleTextSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setCreatedPages([]);
    if (!textInput.trim()) {
      setError('Please enter some text to ingest.');
      return;
    }
    setUploading(true);
    const filename = filenameInput.trim() || `note-${Date.now()}.md`;
    setSourceName(filename);
    try {
      const subjectId = useUIStore.getState().currentSubjectId;
      const res = await apiFetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          subjectId ? { text: textInput, filename, subjectId } : { text: textInput, filename },
        ),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Submit failed (${res.status})`);
      }
      const data = await res.json();
      setJobId(data.jobId);
      setLiveOpen(true);
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (phase !== 'idle') return;
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile, phase],
  );

  // ⌘/Ctrl-I opens the file picker while the hero is idle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'idle' || paste) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        fileRef.current?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, paste]);

  // Full-screen live view — auto-opened on start, dismissable to the background.
  const liveView =
    liveOpen && jobId ? (
      <IngestLiveView
        jobId={jobId}
        sourceName={sourceName || 'Ingesting source'}
        status={status}
        events={events}
        latestMessage={latestMessage}
        createdPages={createdPages}
        onBackground={() => setLiveOpen(false)}
        onIngestAnother={reset}
      />
    ) : null;

  // ── Running ───────────────────────────────────────────────────────────────
  if (phase === 'running') {
    return (
      <>
        {liveView}
        <section
          aria-label="Ingest in progress"
          className="relative overflow-hidden rounded-lg border border-accent/35 bg-surface shadow-sm p-5"
        >
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm font-semibold text-foreground">
              {sourceName || 'Ingesting source'}
            </p>
            <p className="mt-0.5 truncate text-xs text-foreground-secondary">
              <span className="font-semibold text-accent-strong">Working…</span>{' '}
              {latestMessage || 'starting up the agent'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setLiveOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 transition-colors focus-ring"
            >
              <Maximize2 className="h-3.5 w-3.5" /> Watch live
            </button>
            <button
              type="button"
              onClick={() => setShowLog((s) => !s)}
              className="rounded-md px-2 py-1 text-xs font-medium text-foreground-secondary hover:bg-subtle hover:text-foreground transition-colors focus-ring"
            >
              {showLog ? 'Hide log' : 'View log'}
            </button>
          </div>
        </div>

        {/* indeterminate progress — concrete phase % lands in the live ingest view */}
        <div className="mt-3.5 h-1 overflow-hidden rounded-full bg-subtle">
          <span className="ingest-bar-indeterminate block h-full w-1/4 rounded-full bg-accent" />
        </div>

        {cacheStats.promptIn > 0 && (
          <p
            className="mt-3 text-[11px] text-foreground-tertiary"
            title="Input tokens served from the provider prefix cache (billed ~0.1×)"
          >
            Prompt cache hits{' '}
            <span className="font-mono tabular-nums text-foreground-secondary">
              {cacheStats.cacheHit.toLocaleString()} / {cacheStats.promptIn.toLocaleString()} ({cacheStats.pct}%)
            </span>
          </p>
        )}

          {showLog && <EventLog events={events} />}
        </section>
      </>
    );
  }

  // ── Done ────────────────────────────────────────────────────────────────────
  if (phase === 'done') {
    return (
      <>
        {liveView}
        <section
          aria-label="Ingest complete"
          className="flex flex-wrap items-center gap-5 rounded-lg border border-success-border/50 bg-surface shadow-sm p-5"
        >
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-success/12 text-success">
          <CircleCheck className="h-[22px] w-[22px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Ingest complete</p>
          <p className="mt-0.5 text-xs text-foreground-secondary">
            {createdPages.length > 0
              ? `${createdPages.length} ${createdPages.length === 1 ? 'page' : 'pages'} added`
              : 'Vault updated'}
            {sourceName && (
              <>
                {' from '}
                <span className="font-mono text-foreground">{sourceName}</span>
              </>
            )}
          </p>
          {createdPages.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {createdPages.slice(0, 6).map((slug) => (
                <Link key={slug} href={`/wiki/${slug}`} className="focus-ring rounded-sm">
                  <Tag tone="accent">{slug}</Tag>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button intent="outline" onClick={reset}>
            <Plus className="h-3.5 w-3.5" /> Ingest another
          </Button>
          {createdPages.length > 0 && (
            <Link href={`/wiki/${createdPages[0]}`} className={buttonVariants({ intent: 'primary' })}>
              <ArrowRight className="h-3.5 w-3.5" /> View pages
            </Link>
          )}
        </div>
        </section>
      </>
    );
  }

  // ── Failed ────────────────────────────────────────────────────────────────
  if (phase === 'failed') {
    return (
      <>
        {liveView}
        <section
          aria-label="Ingest failed"
          className="rounded-lg border border-danger/40 bg-surface shadow-sm p-5"
        >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-danger/12 text-danger">
            <X className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Ingest failed</p>
            <p className="mt-0.5 text-xs text-danger break-words">
              {error || latestMessage || 'The agent stopped before committing.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowLog((s) => !s)}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-foreground-secondary hover:bg-subtle hover:text-foreground transition-colors focus-ring"
          >
            {showLog ? 'Hide log' : 'View log'}
          </button>
        </div>
        {showLog && <EventLog events={events} />}
        <div className="mt-3.5 flex items-center gap-2">
          <Button intent="primary" size="sm" onClick={handleRetry} loading={retrying} disabled={retrying}>
            {checkpointProgress
              ? `Resume${checkpointProgress.totalPages ? ` · ${checkpointProgress.writerPages}/${checkpointProgress.totalPages} pages` : ''}`
              : 'Retry'}
          </Button>
          <Button intent="ghost" size="sm" onClick={reset}>
            Ingest another source
          </Button>
        </div>
        </section>
      </>
    );
  }

  // ── Idle: paste form ────────────────────────────────────────────────────────
  if (paste) {
    return (
      <section
        aria-label="Paste text to ingest"
        className="rounded-lg border border-border bg-surface shadow-sm p-5 space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ClipboardPaste className="h-4 w-4 text-accent" aria-hidden /> Paste text
          </span>
          <button
            type="button"
            onClick={() => setPaste(false)}
            className="rounded-md px-2 py-1 text-xs font-medium text-foreground-secondary hover:bg-subtle hover:text-foreground transition-colors focus-ring"
          >
            Back
          </button>
        </div>
        <form onSubmit={handleTextSubmit} className="space-y-3">
          <label htmlFor="ingest-filename-input" className="sr-only">
            Filename for the pasted content
          </label>
          <Input
            id="ingest-filename-input"
            type="text"
            placeholder="Filename (optional, e.g. my-notes.md)"
            value={filenameInput}
            onChange={(e) => setFilenameInput(e.target.value)}
          />
          <label htmlFor="ingest-text-input" className="sr-only">
            Source text content
          </label>
          <Textarea
            id="ingest-text-input"
            rows={7}
            autoFocus
            placeholder="Paste Markdown, notes, or any text — the agent will file it into the right pages…"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            className="resize-y"
          />
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-xs text-foreground-tertiary">
              <Layers className="h-3.5 w-3.5" /> Filing into the active subject
            </span>
            <Button type="submit" intent="primary" loading={uploading} disabled={uploading || !textInput.trim()}>
              <Sparkles className="h-3.5 w-3.5" /> Start ingest
            </Button>
          </div>
        </form>
      </section>
    );
  }

  // ── Idle: launcher ────────────────────────────────────────────────────────
  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      aria-label="Ingest a source"
      className={cn(
        'relative overflow-hidden rounded-lg border-[1.5px] border-dashed shadow-sm',
        'grid items-center gap-6 p-6 md:grid-cols-[minmax(0,1fr)_320px]',
        'transition-colors duration-fast ease-standard',
        isDragging ? 'border-accent bg-accent/5' : 'border-border-strong bg-surface',
      )}
    >
      <input
        ref={fileRef}
        id="ingest-file-input"
        type="file"
        accept=".md,.mdx,.txt,.html,.htm,.pdf"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) uploadFile(file);
        }}
      />

      {/* invitation */}
      <div className="flex min-w-0 flex-col gap-3.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent-strong">
          <Sparkles className="h-3 w-3" /> Start here
        </span>
        <div className="flex items-center gap-3.5">
          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent">
            <UploadCloud className="h-6 w-6" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="text-[19px] font-semibold tracking-tight text-foreground">Ingest a source</h2>
            <p className="mt-0.5 text-sm leading-relaxed text-foreground-secondary text-pretty">
              Drop a document or paste text. The agent reads, writes, links, and lints it into your vault —
              and runs in the background while you keep working.
            </p>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            intent="primary"
            size="lg"
            loading={uploading}
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp className="h-[15px] w-[15px]" /> Choose a file
            <Kbd className="ml-1 border-transparent bg-accent-hover/40 text-accent-fg">⌘I</Kbd>
          </Button>
          <Button intent="outline" size="lg" onClick={() => setPaste(true)}>
            <ClipboardPaste className="h-[15px] w-[15px]" /> Paste text
          </Button>
          <span className="text-xs text-foreground-tertiary">or drag &amp; drop anywhere</span>
        </div>
      </div>

      {/* pipeline preview */}
      <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-canvas p-3.5">
        <span className="mb-1 text-[11px] font-medium uppercase tracking-wider text-foreground-tertiary">
          What the agent does
        </span>
        {PIPELINE.map(({ label, Icon }, i) => (
          <div key={label} className="flex h-[26px] items-center gap-2.5">
            <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
              <Icon className="h-3 w-3" aria-hidden />
            </span>
            <span className="text-xs font-medium text-foreground-secondary">{label}</span>
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-foreground-tertiary/70">
              {String(i + 1).padStart(2, '0')}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Compact streamed event log, shared by the running & failed strips. */
function EventLog({ events }: { events: ReturnType<typeof useJobStream>['events'] }) {
  return (
    <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-md border border-border bg-canvas p-3">
      {events.length === 0 ? (
        <li className="text-xs italic text-foreground-tertiary">Waiting for events…</li>
      ) : (
        events.slice(-20).map((evt, i) => {
          const isError = evt.type === 'agent:error';
          const payload = evt.data?.data as { detail?: string; finishReason?: string } | undefined;
          const msg = (evt.data?.message as string) || evt.type;
          const why = isError ? (payload?.detail || payload?.finishReason || '') : '';
          return (
            <li
              key={i}
              className={cn('flex gap-2 text-xs', isError ? 'text-danger' : 'text-foreground-secondary')}
            >
              <span className={cn('shrink-0', isError ? 'text-danger' : 'text-foreground-tertiary')}>
                {isError ? '✗' : '›'}
              </span>
              <span className="truncate">
                {msg}
                {why ? ` — ${why}` : ''}
              </span>
            </li>
          );
        })
      )}
    </ul>
  );
}
