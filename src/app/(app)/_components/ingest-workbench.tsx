'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  FileUp,
  GitCommitHorizontal,
  Layers,
  Link2,
  ListChecks,
  PenLine,
  ScanText,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { useJobStream } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import { takePendingIngestFile } from '@/lib/pending-ingest-file';
import { parseUrlLines } from '@/lib/url-list';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import { IngestLiveView } from './ingest-live-view';
import type { CheckpointProgress, Job } from '@/lib/contracts';

/** The real ingest pipeline's six phases — shown as a "what happens" preview. */
const PIPELINE: ReadonlyArray<{ label: string; Icon: LucideIcon }> = [
  { label: 'Parse', Icon: ScanText },
  { label: 'Plan', Icon: ListChecks },
  { label: 'Write', Icon: PenLine },
  { label: 'Enrich', Icon: Wand2 },
  { label: 'Verify', Icon: ShieldCheck },
  { label: 'Commit', Icon: GitCommitHorizontal },
];

const ACCEPT = '.md,.mdx,.txt,.html,.htm,.pdf';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The dedicated ingest workspace (route `/ingest`). One surface that moves from
 * setup → live progress → completion. The job keeps running in the background
 * if the user navigates away; returning here reflects its current state.
 */
export function IngestWorkbench() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { slug: subjectSlug } = useCurrentSubject();

  const [mode, setMode] = useState<'file' | 'text' | 'url'>('file');
  const [urlInput, setUrlInput] = useState('');
  const [urlResults, setUrlResults] = useState<
    Array<{ url: string; jobId?: string; sourceId?: string; error?: string }> | null
  >(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [checkpointProgress, setCheckpointProgress] = useState<CheckpointProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [textInput, setTextInput] = useState('');
  const [filenameInput, setFilenameInput] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [createdPages, setCreatedPages] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const { events, status, latestMessage } = useJobStream(jobId, reconnectKey);

  const isDone = status === 'completed';

  // Refresh the vault views once an ingest commits.
  useEffect(() => {
    if (!isDone) return;
    queryClient.invalidateQueries({ queryKey: ['pages'] });
    queryClient.invalidateQueries({ queryKey: ['sources'] });
  }, [isDone, queryClient]);

  useEffect(() => {
    if (!isDone) return;
    const doneEvent = events.find((e) => e.type === 'job:completed' || e.type === 'ingest:complete');
    const result = (doneEvent?.data?.data as { result?: { pagesCreated?: string[] } } | undefined)?.result;
    if (result?.pagesCreated) setCreatedPages(result.pagesCreated);
  }, [isDone, events]);

  const reset = useCallback(() => {
    setJobId(null);
    setError(null);
    setCreatedPages([]);
    setSelectedFile(null);
    setTextInput('');
    setFilenameInput('');
    setSourceName('');
    setUrlInput('');
    setUrlResults(null);
    setCheckpointProgress(null);
    setMode('file');
    if (fileRef.current) fileRef.current.value = '';
  }, []);

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
      // The job kept its id, so the global ProgressToast / IngestPill (which
      // subscribe by id) are still pinned to the closed, failed stream. Tell
      // them the job restarted so they re-subscribe and resume live progress.
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [jobId]);

  // 手动结束当前 ingest：停掉运行中的任务、或放弃已报错的任务（后端清检查点使其不可 resume），
  // 然后清空工作台回到上传态。终态以 SSE/后端为准，这里失败也不阻断关闭。
  const handleTerminate = useCallback(async () => {
    if (!jobId || terminating) return;
    setTerminating(true);
    try {
      await apiFetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch {
      /* 忽略：即便请求失败也允许用户离开这个卡住的任务 */
    } finally {
      setTerminating(false);
      reset();
    }
  }, [jobId, terminating, reset]);

  // After a failure, fetch the checkpoint progress for the resume label.
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
        /* the progress label is a nicety */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, jobId]);

  // A file handed off from the dashboard "Choose a file" hero takes precedence:
  // start its upload immediately and watch it live here. The ref guard keeps
  // this idempotent under React StrictMode's double-invoked effects (dev), and
  // signals the restore effect below to stand down so it can't clobber the new
  // job's id with a previously failed one.
  const handoffStarted = useRef(false);
  useEffect(() => {
    if (handoffStarted.current) return;
    const handoff = takePendingIngestFile();
    if (!handoff) return;
    handoffStarted.current = true;
    setSelectedFile(handoff);
    void startUpload(handoff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount: reflect an in-progress background ingest, or restore the most
  // recent resumable failed one for this subject. Skipped when a dashboard
  // handoff is already driving a fresh upload.
  useEffect(() => {
    if (handoffStarted.current) return;
    let cancelled = false;
    (async () => {
      const subjectId = useUIStore.getState().currentSubjectId;
      if (!subjectId) return;
      try {
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
        const latest = resumable[resumable.length - 1];
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
    // Restore is attempted once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startUpload = useCallback(async (file: File) => {
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
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const handleStart = async () => {
    if (mode === 'file') {
      if (!selectedFile) {
        fileRef.current?.click();
        return;
      }
      await startUpload(selectedFile);
      return;
    }
    if (mode === 'url') {
      const { urls, invalid } = parseUrlLines(urlInput);
      if (invalid.length > 0) {
        setError(`Invalid URLs (must start with http:// or https://): ${invalid.join(', ')}`);
        return;
      }
      if (urls.length === 0) {
        setError('Please enter at least one URL.');
        return;
      }
      setError(null);
      setCreatedPages([]);
      setUrlResults(null);
      setUploading(true);
      try {
        const subjectId = useUIStore.getState().currentSubjectId;
        const res = await apiFetch('/api/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subjectId ? { urls, subjectId } : { urls }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 422) {
          throw new Error(data.error || `Submit failed (${res.status})`);
        }
        const results = (data.results ?? []) as Array<{ url: string; jobId?: string; error?: string }>;
        const jobIds = results.filter((r) => r.jobId).map((r) => r.jobId!);
        // 通知全局 ProgressToast 追踪每个后台 job
        for (const id of jobIds) {
          window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: id } }));
        }
        if (jobIds.length === 1 && results.length === 1) {
          // 单 URL 全成功：直接进入现有 live view
          setSourceName(results[0].url);
          setJobId(jobIds[0]);
        } else {
          // 批量：留在本页展示逐条结果（jobs 在后台跑，toast 追踪）
          setUrlResults(results);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
      return;
    }
    // Text mode
    if (!textInput.trim()) {
      setError('Please enter some text to ingest.');
      return;
    }
    setError(null);
    setCreatedPages([]);
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
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      setMode('file');
      setSelectedFile(file);
      setError(null);
    }
  }, []);

  // ── Live / done / failed: the unified progress surface ──────────────────────
  if (jobId) {
    return (
      <IngestLiveView
        inline
        jobId={jobId}
        sourceName={sourceName || 'Ingesting source'}
        status={status}
        events={events}
        latestMessage={latestMessage}
        createdPages={createdPages}
        onBackground={() => router.push('/')}
        onIngestAnother={reset}
        onRetry={handleRetry}
        retrying={retrying}
        retryLabel={
          checkpointProgress
            ? `Resume${checkpointProgress.totalPages ? ` · ${checkpointProgress.writerPages}/${checkpointProgress.totalPages} pages` : ''}`
            : 'Retry'
        }
        onTerminate={handleTerminate}
        terminating={terminating}
      />
    );
  }

  // ── Setup ───────────────────────────────────────────────────────────────────
  const canStart =
    mode === 'file' ? !!selectedFile : mode === 'url' ? !!urlInput.trim() : !!textInput.trim();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 pb-16 pt-12">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              setSelectedFile(file);
              setError(null);
            }
          }}
        />

        {/* header */}
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent/12 text-accent">
              <UploadCloud className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Ingest a source</h1>
          </div>
          <p className="max-w-[560px] text-sm leading-relaxed text-foreground-secondary">
            Drop a document or paste text — the agent plans, writes, links, and lints the vault for
            you. It runs in the background, so you can keep reading while it works.
          </p>
        </header>

        {/* card */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold text-foreground">New ingest</span>
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'file' | 'text' | 'url')}>
              <TabsList>
                <TabsTrigger value="file">File</TabsTrigger>
                <TabsTrigger value="text">Text</TabsTrigger>
                <TabsTrigger value="url">URL</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="flex flex-col gap-4 p-4">
            {mode === 'file' ? (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={cn(
                  'flex w-full flex-col items-center gap-2 rounded-lg border-[1.5px] border-dashed px-4 py-8 text-center transition-colors duration-fast ease-standard focus-ring',
                  isDragging
                    ? 'border-accent bg-accent/[0.04]'
                    : selectedFile
                      ? 'border-accent/60 bg-accent/[0.04]'
                      : 'border-border-strong bg-canvas hover:border-accent hover:bg-accent/[0.04]',
                )}
              >
                {selectedFile ? (
                  <>
                    <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                      <FileUp className="h-5 w-5 text-accent" aria-hidden />
                      <span className="font-mono">{selectedFile.name}</span>
                    </span>
                    <span className="font-mono text-xs text-foreground-tertiary">
                      {formatBytes(selectedFile.size)} · click to choose another
                    </span>
                  </>
                ) : (
                  <>
                    <FileUp className="h-6 w-6 text-foreground-tertiary" aria-hidden />
                    <span className="text-sm font-medium text-foreground">
                      Drag &amp; drop, or click to browse
                    </span>
                    <span className="font-mono text-xs text-foreground-tertiary">
                      .md · .txt · .html · .pdf — up to 50 MB
                    </span>
                  </>
                )}
              </button>
            ) : mode === 'url' ? (
              <div className="flex flex-col gap-3">
                <Textarea
                  rows={7}
                  autoFocus
                  placeholder={'One URL per line, e.g.\nhttps://example.com/article\nhttps://docs.example.com/guide'}
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  aria-label="URLs to ingest, one per line"
                />
                <span className="font-mono text-xs text-foreground-tertiary">
                  Up to 20 URLs · fetched server-side · 5 MB per page
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <Input
                  type="text"
                  placeholder="Filename (optional, e.g. my-notes.md)"
                  value={filenameInput}
                  onChange={(e) => setFilenameInput(e.target.value)}
                  aria-label="Filename for the pasted content"
                />
                <Textarea
                  rows={7}
                  autoFocus
                  placeholder="Paste Markdown, notes, or any text — the agent will file it into the right pages…"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                />
              </div>
            )}

            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}

            {urlResults && (
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-canvas p-3">
                <span className="text-xs font-semibold text-foreground">
                  {urlResults.filter((r) => r.jobId).length}/{urlResults.length} URLs queued
                </span>
                <ul className="flex flex-col gap-1">
                  {urlResults.map((r) => (
                    <li key={r.url} className="flex items-start gap-2 text-xs">
                      <Link2
                        className={cn('mt-0.5 h-3 w-3 shrink-0', r.jobId ? 'text-accent' : 'text-danger')}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="break-all font-mono text-foreground-secondary">{r.url}</span>
                        {r.error && <span className="text-danger"> — {r.error}</span>}
                        {r.jobId && <span className="text-foreground-tertiary"> — queued</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="text-xs text-foreground-tertiary">
                  Jobs run in the background — watch progress in the corner toast.
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="flex items-center gap-1.5 text-xs text-foreground-tertiary">
                <Layers className="h-3.5 w-3.5" /> Filing into{' '}
                <span className="font-mono text-foreground-secondary">{subjectSlug}</span>
              </span>
              <Button
                intent="primary"
                size="lg"
                onClick={() => handleStart()}
                loading={uploading}
                disabled={uploading || !canStart}
              >
                <Sparkles className="h-3.5 w-3.5" /> Start ingest
              </Button>
            </div>
          </div>
        </div>

        {/* pipeline preview */}
        <div className="flex flex-wrap gap-2">
          {PIPELINE.map(({ label, Icon }) => (
            <span
              key={label}
              className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-xs text-foreground-tertiary"
            >
              <Icon className="h-3 w-3" aria-hidden /> {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
